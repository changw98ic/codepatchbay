import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createJobAndHandleBlocked } from "../core/engine/run-job-prepare.js";
import { appendEvent, materializeJob, readEvents } from "../server/services/event/event-store.js";
import {
  parseManagedWorktreeContext,
  parseWorktreeOwnership,
} from "../core/contracts/worktree-ownership.js";

const ownership = {
  version: 2 as const,
  state: "ready" as const,
  ownerToken: "11111111-1111-4111-8111-111111111111",
  baseBranch: "release/base",
  baseCommit: "a".repeat(40),
  directory: {
    dev: "1",
    ino: "2",
    birthtimeNs: "3",
    mode: "16877",
    uid: "501",
    gid: "20",
  },
};

const managedWorktree = {
  path: "/managed/worktrees/job-owned-pipeline",
  branch: "cpb/job-owned-pipeline",
  baseBranch: ownership.baseBranch,
  baseCommit: ownership.baseCommit,
  ownership,
};

test("worktree ownership contract rejects prepared or incomplete external state", () => {
  assert.throws(
    () => parseWorktreeOwnership({ ...ownership, state: "prepared", directory: undefined }),
    /unexpected or missing fields|not ready/i,
  );
  assert.throws(
    () => parseManagedWorktreeContext({ ...managedWorktree, ownership: { ...ownership, ownerToken: "predictable" } }),
    /canonical random UUID/i,
  );
  assert.throws(
    () => parseManagedWorktreeContext({ ...managedWorktree, baseCommit: "b".repeat(40) }),
    /do not match ownership binding/i,
  );
});

test("run-job persists the exact managed worktree binding immediately after job creation", async () => {
  const events: Array<Record<string, unknown>> = [];
  let createCalls = 0;
  const result = await createJobAndHandleBlocked({
    cpbRoot: "/cpb",
    hubRoot: "/hub",
    project: "flow",
    task: "owned worktree",
    jobId: "job-owned",
    workflow: "standard",
    planMode: "full",
    sourcePath: managedWorktree.path,
    managedWorktree,
    sourceContext: {},
    dynamicAgentPlan: null,
    _jobId: undefined,
    _attemptId: undefined,
    createJob: async () => {
      createCalls += 1;
      return { jobId: "job-owned" };
    },
    blockJob: async () => {},
    appendEvent: async (_root, _project, _jobId, event) => {
      events.push(event);
    },
    prepareTask: async () => ({}),
    onProgress: async () => {},
  });

  assert.equal(result.kind, "ok");
  assert.equal(createCalls, 1);
  assert.deepEqual(events.map((event) => event.type), ["job_started", "worktree_created"]);
  assert.deepEqual(events[1], {
    type: "worktree_created",
    jobId: "job-owned",
    project: "flow",
    worktree: managedWorktree.path,
    branch: managedWorktree.branch,
    baseBranch: managedWorktree.baseBranch,
    baseCommit: managedWorktree.baseCommit,
    worktreeOwnership: ownership,
    ts: events[1].ts,
  });
});

test("run-job rejects a mismatched managed path before creating durable job state", async () => {
  let createCalls = 0;
  await assert.rejects(
    createJobAndHandleBlocked({
      cpbRoot: "/cpb",
      hubRoot: "/hub",
      project: "flow",
      task: "mismatched worktree",
      jobId: "job-owned",
      workflow: "standard",
      planMode: "full",
      sourcePath: "/different/path",
      managedWorktree,
      sourceContext: {},
      dynamicAgentPlan: null,
      _jobId: undefined,
      _attemptId: undefined,
      createJob: async () => {
        createCalls += 1;
        return { jobId: "job-owned" };
      },
      blockJob: async () => {},
      appendEvent: async () => {},
      prepareTask: async () => ({}),
      onProgress: async () => {},
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "WORKTREE_OWNERSHIP_CONTRACT_INVALID");
      return true;
    },
  );
  assert.equal(createCalls, 0);
});

test("event projection preserves the exact worktree ownership proof and rejects malformed proof", () => {
  const projected = materializeJob([{
    type: "worktree_created",
    worktree: managedWorktree.path,
    branch: managedWorktree.branch,
    baseBranch: managedWorktree.baseBranch,
    baseCommit: managedWorktree.baseCommit,
    worktreeOwnership: ownership,
  }]);
  assert.equal(projected.worktree, managedWorktree.path);
  assert.equal(projected.worktreeBranch, managedWorktree.branch);
  assert.equal(projected.worktreeBaseBranch, managedWorktree.baseBranch);
  assert.equal(projected.worktreeBaseCommit, managedWorktree.baseCommit);
  assert.deepEqual(projected.worktreeOwnership, ownership);

  assert.throws(
    () => materializeJob([{
      type: "worktree_created",
      worktree: managedWorktree.path,
      branch: managedWorktree.branch,
      baseBranch: managedWorktree.baseBranch,
      baseCommit: managedWorktree.baseCommit,
      worktreeOwnership: { ...ownership, directory: { ...ownership.directory, ino: "0" } },
    }]),
    /directory\.ino must be non-zero/i,
  );
});

test("event persistence preserves only a validated worktree owner token through secret redaction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worktree-event-"));
  const dataRoot = path.join(root, "runtime");
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendEvent(root, "flow", "job-owned-event", {
    type: "worktree_created",
    jobId: "job-owned-event",
    project: "flow",
    worktree: managedWorktree.path,
    branch: managedWorktree.branch,
    baseBranch: managedWorktree.baseBranch,
    baseCommit: managedWorktree.baseCommit,
    worktreeOwnership: ownership,
  }, { dataRoot });

  const events = await readEvents(root, "flow", "job-owned-event", { dataRoot });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].worktreeOwnership, ownership);

  await assert.rejects(
    appendEvent(root, "flow", "job-invalid-event", {
      type: "worktree_created",
      jobId: "job-invalid-event",
      project: "flow",
      worktreeOwnership: { ...ownership, ownerToken: "looks-secret-but-is-not-a-uuid" },
    }, { dataRoot }),
    /canonical random UUID/i,
  );
});
