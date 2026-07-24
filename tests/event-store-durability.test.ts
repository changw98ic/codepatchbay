import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendEvent,
  appendEventIfCursor,
  checkpointJob,
  ensureEventStreamDurable,
  eventFileFor,
  onEventWritten,
  readCheckpoint,
  readEventStreamCursor,
  readEvents,
  recoverEventFile,
  withEventLockTestHooksForTests,
} from "../server/services/event/event-store.js";
import type { EventRecord } from "../server/services/event/event-types.js";
import {
  getJob,
  readJobsIndex,
  updateJobsIndexEntry,
  withJobsIndexLockTestHooksForTests,
} from "../server/services/job/job-store.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jobCreated(jobId: string, task = "durable event test"): EventRecord {
  return {
    type: "job_created",
    jobId,
    project: "flow",
    task,
    workflow: "standard",
    ts: "2026-07-22T00:00:00.000Z",
  };
}

function phaseStarted(jobId: string): EventRecord {
  return {
    type: "phase_started",
    jobId,
    project: "flow",
    phase: "execute",
    ts: "2026-07-22T00:00:01.000Z",
  };
}

function jobCompleted(jobId: string): EventRecord {
  return {
    type: "job_completed",
    jobId,
    project: "flow",
    ts: "2026-07-22T00:00:01.000Z",
  };
}

async function fixture(prefix: string, jobId: string) {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), prefix));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const options = { dataRoot };
  const file = eventFileFor(cpbRoot, "flow", jobId, options);
  return { cpbRoot, dataRoot, options, file };
}

test("readEvents never repairs a malformed tail and can observe an append without mutating it", async () => {
  const jobId = "job-event-read-race";
  const state = await fixture("cpb-event-read-race-", jobId);
  try {
    await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options);

    const appendWritten = deferred();
    const releaseAppend = deferred();
    const appendPromise = withEventLockTestHooksForTests({
      afterAppendWrite: async () => {
        appendWritten.resolve();
        await releaseAppend.promise;
      },
    }, () => appendEvent(state.cpbRoot, "flow", jobId, phaseStarted(jobId), state.options));

    await appendWritten.promise;
    const beforeRead = await readFile(state.file, "utf8");
    const concurrent = await readEvents(state.cpbRoot, "flow", jobId, state.options);
    const afterRead = await readFile(state.file, "utf8");
    assert.deepEqual(concurrent.map((event) => event.type), ["job_created", "phase_started"]);
    assert.equal(afterRead, beforeRead);
    releaseAppend.resolve();
    await appendPromise;

    const partial = `${await readFile(state.file, "utf8")}{\"type\":`;
    await writeFile(state.file, partial, "utf8");
    await assert.rejects(
      () => readEvents(state.cpbRoot, "flow", jobId, state.options),
      /malformed event JSON/,
    );
    assert.equal(await readFile(state.file, "utf8"), partial);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("recoverEventFile serializes repair against append under the same event lock", async () => {
  const jobId = "job-event-recover-race";
  const state = await fixture("cpb-event-recover-race-", jobId);
  try {
    await mkdir(path.dirname(state.file), { recursive: true });
    const firstLine = `${JSON.stringify(jobCreated(jobId))}\n`;
    const corruptTail = "{\"type\":\"phase_started\"";
    await writeFile(state.file, firstLine + corruptTail, "utf8");

    const recoveryRead = deferred();
    const releaseRecovery = deferred();
    const recoveryPromise = withEventLockTestHooksForTests({
      afterRecoveryRead: async () => {
        recoveryRead.resolve();
        await releaseRecovery.promise;
      },
    }, () => recoverEventFile(state.cpbRoot, "flow", jobId, state.options));
    await recoveryRead.promise;

    let appendSettled = false;
    const appendPromise = appendEvent(
      state.cpbRoot,
      "flow",
      jobId,
      phaseStarted(jobId),
      state.options,
    ).finally(() => { appendSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(appendSettled, false);

    releaseRecovery.resolve();
    const recovered = await recoveryPromise;
    await appendPromise;
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.removedBytes, Buffer.byteLength(corruptTail));
    assert.deepEqual(
      (await readEvents(state.cpbRoot, "flow", jobId, state.options)).map((event) => event.type),
      ["job_created", "phase_started"],
    );
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEvent rejects a replaced canonical path and preserves its successor", async () => {
  const jobId = "job-event-append-successor";
  const state = await fixture("cpb-event-append-successor-", jobId);
  const predecessor = `${state.file}.predecessor`;
  try {
    await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId, "predecessor"), state.options);
    const successor = `${JSON.stringify(jobCreated(jobId, "successor"))}\n`;

    await assert.rejects(
      withEventLockTestHooksForTests({
        afterAppendOpen: async ({ filePath }) => {
          await rename(filePath, predecessor);
          await writeFile(filePath, successor, { encoding: "utf8", flag: "wx" });
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, phaseStarted(jobId), state.options)),
      (error: Error & { code?: string; successorPreserved?: boolean }) => {
        assert.equal(error.code, "EVENT_FILE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );

    assert.equal(await readFile(state.file, "utf8"), successor);
    assert.match(await readFile(predecessor, "utf8"), /predecessor/);
    assert.doesNotMatch(await readFile(predecessor, "utf8"), /phase_started/);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("recoverEventFile is generation-bound and never rewrites a successor", async () => {
  const jobId = "job-event-recover-successor";
  const state = await fixture("cpb-event-recover-successor-", jobId);
  const predecessor = `${state.file}.predecessor`;
  try {
    await mkdir(path.dirname(state.file), { recursive: true });
    const corrupt = `${JSON.stringify(jobCreated(jobId, "predecessor"))}\n{\"partial\":`;
    const successor = `${JSON.stringify(jobCreated(jobId, "successor"))}\n`;
    await writeFile(state.file, corrupt, "utf8");

    await assert.rejects(
      withEventLockTestHooksForTests({
        afterRecoveryRead: async ({ filePath }) => {
          await rename(filePath, predecessor);
          await writeFile(filePath, successor, { encoding: "utf8", flag: "wx" });
        },
      }, () => recoverEventFile(state.cpbRoot, "flow", jobId, state.options)),
      (error: Error & { code?: string; successorPreserved?: boolean }) => {
        assert.equal(error.code, "EVENT_FILE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );

    assert.equal(await readFile(state.file, "utf8"), successor);
    assert.equal(await readFile(predecessor, "utf8"), corrupt);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEvent rejects file fsync failure and emits no durability notification", async () => {
  const jobId = "job-event-file-fsync";
  const state = await fixture("cpb-event-file-fsync-", jobId);
  let notifications = 0;
  const unsubscribe = onEventWritten(() => { notifications += 1; });
  try {
    const fsyncFailure = Object.assign(new Error("injected event file fsync failure"), { code: "EIO" });
    await assert.rejects(
      withEventLockTestHooksForTests({
        beforeEventFileSync: ({ operation }) => {
          if (operation === "append") throw fsyncFailure;
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options)),
      (error: Error & { code?: string; committed?: boolean | null; durabilityAmbiguous?: boolean; commitState?: string }) => {
        assert.equal(error.code, "EVENT_APPEND_DURABILITY_AMBIGUOUS");
        assert.equal(error.committed, null);
        assert.equal(error.durabilityAmbiguous, true);
        assert.equal(error.commitState, "write-complete");
        return true;
      },
    );
    assert.equal(notifications, 0);
    assert.match(await readFile(state.file, "utf8"), /job_created/);
  } finally {
    unsubscribe();
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEvent preserves a primary fsync failure together with a secondary close failure", async () => {
  const jobId = "job-event-fsync-close";
  const state = await fixture("cpb-event-fsync-close-", jobId);
  try {
    const fsyncFailure = Object.assign(new Error("primary event fsync failure"), { code: "EIO" });
    const closeFailure = Object.assign(new Error("secondary event close failure"), { code: "ECLOSE" });
    await assert.rejects(
      withEventLockTestHooksForTests({
        beforeEventFileSync: ({ operation }) => {
          if (operation === "append") throw fsyncFailure;
        },
        afterEventHandleClose: ({ authority }) => {
          if (authority === "file") throw closeFailure;
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options)),
      (error: AggregateError & {
        code?: string;
        primaryError?: Error & { code?: string };
        closeErrors?: Array<Error & { code?: string }>;
      }) => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.code, "EVENT_APPEND_DURABILITY_AMBIGUOUS");
        assert.equal(error.primaryError?.code, "EVENT_APPEND_DURABILITY_AMBIGUOUS");
        assert.equal(error.closeErrors?.length, 1);
        assert.equal(error.closeErrors?.[0], closeFailure);
        assert.equal(error.errors.includes(error.primaryError), true);
        assert.equal(error.errors.includes(closeFailure), true);
        return true;
      },
    );
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEvent fails closed when the canonical file is replaced after its descriptor closes", async () => {
  const jobId = "job-event-post-close-file";
  const state = await fixture("cpb-event-post-close-file-", jobId);
  const predecessor = `${state.file}.predecessor`;
  const successor = `${JSON.stringify(jobCreated(jobId, "successor"))}\n`;
  let notifications = 0;
  const unsubscribe = onEventWritten(() => { notifications += 1; });
  try {
    await assert.rejects(
      withEventLockTestHooksForTests({
        afterEventHandleClose: async ({ authority, filePath }) => {
          if (authority !== "file") return;
          await rename(filePath, predecessor);
          await writeFile(filePath, successor, { encoding: "utf8", flag: "wx" });
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId, "predecessor"), state.options)),
      (error: Error & { code?: string; successorPreserved?: boolean }) => {
        assert.equal(error.code, "EVENT_FILE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
    assert.equal(notifications, 0);
    assert.equal(await readFile(state.file, "utf8"), successor);
    assert.match(await readFile(predecessor, "utf8"), /predecessor/);
  } finally {
    unsubscribe();
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("recoverEventFile fails closed when the parent directory is replaced after close", async () => {
  const jobId = "job-event-post-close-parent";
  const state = await fixture("cpb-event-post-close-parent-", jobId);
  const originalDirectory = path.dirname(state.file);
  const predecessorDirectory = `${originalDirectory}.predecessor`;
  const successor = `${JSON.stringify(jobCreated(jobId, "successor"))}\n`;
  try {
    await mkdir(originalDirectory, { recursive: true });
    await writeFile(state.file, `${JSON.stringify(jobCreated(jobId, "predecessor"))}\n{\"partial\":`, "utf8");
    await assert.rejects(
      withEventLockTestHooksForTests({
        afterEventHandleClose: async ({ authority }) => {
          if (authority !== "directory") return;
          await rename(originalDirectory, predecessorDirectory);
          await mkdir(originalDirectory);
          await writeFile(state.file, successor, { encoding: "utf8", flag: "wx" });
        },
      }, () => recoverEventFile(state.cpbRoot, "flow", jobId, state.options)),
      (error: Error & { code?: string; successorPreserved?: boolean }) => {
        assert.equal(error.code, "EVENT_FILE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
    assert.equal(await readFile(state.file, "utf8"), successor);
    assert.match(await readFile(path.join(predecessorDirectory, path.basename(state.file)), "utf8"), /predecessor/);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("new event file requires parent fsync before appendEvent reports success", async () => {
  const jobId = "job-event-parent-fsync";
  const state = await fixture("cpb-event-parent-fsync-", jobId);
  let notifications = 0;
  const unsubscribe = onEventWritten(() => { notifications += 1; });
  try {
    const fsyncFailure = Object.assign(new Error("injected event parent fsync failure"), { code: "EIO" });
    await assert.rejects(
      withEventLockTestHooksForTests({
        beforeEventParentSync: () => { throw fsyncFailure; },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options)),
      (error: Error & { code?: string; committed?: boolean | null; durabilityAmbiguous?: boolean; commitState?: string }) => {
        assert.equal(error.code, "EVENT_APPEND_DURABILITY_AMBIGUOUS");
        assert.equal(error.committed, null);
        assert.equal(error.durabilityAmbiguous, true);
        assert.equal(error.commitState, "file-synced");
        return true;
      },
    );
    assert.equal(notifications, 0);
    assert.match(await readFile(state.file, "utf8"), /job_created/);
  } finally {
    unsubscribe();
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("ensureEventStreamDurable promotes a complete record after file-fsync ambiguity", async () => {
  const jobId = "job-event-promote-file-fsync";
  const state = await fixture("cpb-event-promote-file-fsync-", jobId);
  try {
    await assert.rejects(
      withEventLockTestHooksForTests({
        beforeEventFileSync: ({ operation }) => {
          if (operation === "append") throw Object.assign(new Error("injected append fsync failure"), { code: "EIO" });
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options)),
      (error: Error & { committed?: boolean | null }) => {
        assert.equal(error.committed, null);
        return true;
      },
    );

    let fileSyncs = 0;
    let parentSyncs = 0;
    const promoted = await withEventLockTestHooksForTests({
      beforeEventFileSync: ({ operation }) => {
        if (operation === "ensure") fileSyncs += 1;
      },
      beforeEventParentSync: () => { parentSyncs += 1; },
    }, () => ensureEventStreamDurable(state.cpbRoot, "flow", jobId, state.options));

    assert.deepEqual(promoted, {
      backend: "filesystem",
      committed: true,
      exists: true,
      cursor: await readEventStreamCursor(state.cpbRoot, "flow", jobId, state.options),
      file: state.file,
    });
    assert.equal(fileSyncs, 1);
    assert.equal(parentSyncs, 1);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("ensureEventStreamDurable promotes a complete record after parent-fsync ambiguity", async () => {
  const jobId = "job-event-promote-parent-fsync";
  const state = await fixture("cpb-event-promote-parent-fsync-", jobId);
  try {
    await assert.rejects(
      withEventLockTestHooksForTests({
        beforeEventParentSync: () => {
          throw Object.assign(new Error("injected append parent fsync failure"), { code: "EIO" });
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options)),
      (error: Error & { committed?: boolean | null }) => {
        assert.equal(error.committed, null);
        return true;
      },
    );

    let fileSyncs = 0;
    let parentSyncs = 0;
    const promoted = await withEventLockTestHooksForTests({
      beforeEventFileSync: ({ operation }) => {
        if (operation === "ensure") fileSyncs += 1;
      },
      beforeEventParentSync: () => { parentSyncs += 1; },
    }, () => ensureEventStreamDurable(state.cpbRoot, "flow", jobId, state.options));
    assert.equal(promoted.committed, true);
    assert.equal(promoted.exists, true);
    assert.equal(promoted.cursor.eventCount, 1);
    assert.equal(fileSyncs, 1);
    assert.equal(parentSyncs, 1);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("ensureEventStreamDurable rejects partial JSONL, symlinks, and canonical successors", async () => {
  const partialJobId = "job-event-promote-partial";
  const partial = await fixture("cpb-event-promote-partial-", partialJobId);
  try {
    await mkdir(path.dirname(partial.file), { recursive: true });
    await writeFile(partial.file, JSON.stringify(jobCreated(partialJobId)), "utf8");
    await assert.rejects(
      () => ensureEventStreamDurable(partial.cpbRoot, "flow", partialJobId, partial.options),
      (error: Error & { code?: string; committed?: boolean | null }) => {
        assert.equal(error.code, "EVENT_STREAM_PARTIAL_RECORD");
        assert.equal(error.committed, null);
        return true;
      },
    );
  } finally {
    await rm(partial.cpbRoot, { recursive: true, force: true });
  }

  const symlinkJobId = "job-event-promote-symlink";
  const unsafe = await fixture("cpb-event-promote-symlink-", symlinkJobId);
  try {
    await mkdir(path.dirname(unsafe.file), { recursive: true });
    const target = `${unsafe.file}.target`;
    await writeFile(target, `${JSON.stringify(jobCreated(symlinkJobId))}\n`, "utf8");
    await symlink(target, unsafe.file);
    await assert.rejects(
      () => ensureEventStreamDurable(unsafe.cpbRoot, "flow", symlinkJobId, unsafe.options),
      (error: Error & { code?: string; committed?: boolean | null }) => {
        assert.equal(error.code, "EVENT_FILE_UNSAFE");
        assert.equal(error.committed, null);
        return true;
      },
    );
  } finally {
    await rm(unsafe.cpbRoot, { recursive: true, force: true });
  }

  const successorJobId = "job-event-promote-successor";
  const successorState = await fixture("cpb-event-promote-successor-", successorJobId);
  const predecessor = `${successorState.file}.predecessor`;
  try {
    await appendEvent(
      successorState.cpbRoot,
      "flow",
      successorJobId,
      jobCreated(successorJobId, "predecessor"),
      successorState.options,
    );
    const successor = `${JSON.stringify(jobCreated(successorJobId, "successor"))}\n`;
    await assert.rejects(
      withEventLockTestHooksForTests({
        afterDurabilityOpen: async ({ filePath }) => {
          await rename(filePath, predecessor);
          await writeFile(filePath, successor, { encoding: "utf8", flag: "wx" });
        },
      }, () => ensureEventStreamDurable(
        successorState.cpbRoot,
        "flow",
        successorJobId,
        successorState.options,
      )),
      (error: Error & { code?: string; committed?: boolean | null; successorPreserved?: boolean }) => {
        assert.equal(error.code, "EVENT_FILE_SUCCESSOR_PRESERVED");
        assert.equal(error.committed, null);
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
    assert.equal(await readFile(successorState.file, "utf8"), successor);
    assert.match(await readFile(predecessor, "utf8"), /predecessor/);
  } finally {
    await rm(successorState.cpbRoot, { recursive: true, force: true });
  }
});

test("event file mutation refuses a symbolic-link target", async () => {
  const jobId = "job-event-symlink";
  const state = await fixture("cpb-event-symlink-", jobId);
  const target = path.join(state.cpbRoot, "outside.jsonl");
  try {
    await mkdir(path.dirname(state.file), { recursive: true });
    await writeFile(target, "outside\n", "utf8");
    await symlink(target, state.file);
    await assert.rejects(
      () => appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "EVENT_FILE_UNSAFE");
        return true;
      },
    );
    assert.equal(await readFile(target, "utf8"), "outside\n");
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("readCheckpoint rejects a symbolic-link checkpoint instead of accepting forged state", async () => {
  const jobId = "job-checkpoint-read-symlink";
  const state = await fixture("cpb-checkpoint-read-symlink-", jobId);
  const checkpoint = path.join(state.dataRoot, "checkpoints", "flow", `${jobId}.json`);
  const outside = path.join(state.cpbRoot, "forged-checkpoint.json");
  try {
    await mkdir(path.dirname(checkpoint), { recursive: true });
    await writeFile(outside, `${JSON.stringify({
      _meta: { version: 1 },
      state: { jobId, project: "flow", status: "completed", forged: true },
    })}\n`, "utf8");
    await symlink(outside, checkpoint);
    await assert.rejects(
      () => readCheckpoint(state.cpbRoot, "flow", jobId, state.options),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "EVENT_FILE_UNSAFE");
        return true;
      },
    );
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("readCheckpoint rejects a canonical successor installed after descriptor close", async () => {
  const jobId = "job-checkpoint-read-successor";
  const state = await fixture("cpb-checkpoint-read-successor-", jobId);
  const checkpoint = path.join(state.dataRoot, "checkpoints", "flow", `${jobId}.json`);
  const predecessor = `${checkpoint}.predecessor`;
  const initial = `${JSON.stringify({
    _meta: { version: 1 },
    state: { jobId, project: "flow", status: "completed", generation: "predecessor" },
  })}\n`;
  const successor = `${JSON.stringify({
    _meta: { version: 1 },
    state: { jobId, project: "flow", status: "failed", generation: "successor" },
  })}\n`;
  try {
    await mkdir(path.dirname(checkpoint), { recursive: true });
    await writeFile(checkpoint, initial, "utf8");
    await assert.rejects(
      withEventLockTestHooksForTests({
        afterEventHandleClose: async ({ authority, filePath }) => {
          if (authority !== "file") return;
          await rename(filePath, predecessor);
          await writeFile(filePath, successor, { encoding: "utf8", flag: "wx" });
        },
      }, () => readCheckpoint(state.cpbRoot, "flow", jobId, state.options)),
      (error: Error & { code?: string; successorPreserved?: boolean }) => {
        assert.equal(error.code, "EVENT_FILE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
    assert.equal(await readFile(checkpoint, "utf8"), successor);
    assert.equal(await readFile(predecessor, "utf8"), initial);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("readCheckpoint never hides an invalid runtime checkpoint behind legacy fallback", async () => {
  const jobId = "job-checkpoint-runtime-invalid";
  const state = await fixture("cpb-checkpoint-runtime-invalid-", jobId);
  const runtimeCheckpoint = path.join(state.dataRoot, "checkpoints", "flow", `${jobId}.json`);
  const legacyCheckpoint = path.join(state.cpbRoot, "cpb-task", "checkpoints", "flow", `${jobId}.json`);
  try {
    await mkdir(path.dirname(runtimeCheckpoint), { recursive: true });
    await mkdir(path.dirname(legacyCheckpoint), { recursive: true });
    await writeFile(runtimeCheckpoint, "{\"state\":", "utf8");
    await writeFile(legacyCheckpoint, `${JSON.stringify({
      _meta: { version: 1 },
      state: { jobId, project: "flow", status: "completed", staleLegacy: true },
    })}\n`, "utf8");
    await assert.rejects(
      () => readCheckpoint(state.cpbRoot, "flow", jobId, {
        ...state.options,
        includeLegacyFallback: true,
      }),
      /malformed checkpoint/,
    );
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("getJob validates a terminal checkpoint prefix and replays every allowed suffix event exactly once", async () => {
  const jobId = "job-checkpoint-post-terminal-replay";
  const state = await fixture("cpb-checkpoint-post-terminal-replay-", jobId);
  const checkpoint = path.join(state.dataRoot, "checkpoints", "flow", `${jobId}.json`);
  try {
    await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options);
    await appendEvent(state.cpbRoot, "flow", jobId, jobCompleted(jobId), state.options);
    await checkpointJob(state.cpbRoot, "flow", jobId, state.options);

    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(saved._meta.cursorVersion, 1);
    assert.equal(saved._meta.eventCount, 2);
    assert.match(saved._meta.eventDigest, /^[a-f0-9]{64}$/);
    assert.match(saved._meta.stateDigest, /^[a-f0-9]{64}$/);

    await appendEvent(state.cpbRoot, "flow", jobId, {
      type: "phase_activity",
      jobId,
      project: "flow",
      message: "post-checkpoint truth",
      ts: "2026-07-22T00:00:02.000Z",
    }, state.options);
    await appendEvent(state.cpbRoot, "flow", jobId, {
      type: "pr_opened",
      jobId,
      project: "flow",
      artifact: "review-report.json",
      prUrl: "https://example.test/pull/17",
      prNumber: 17,
      ts: "2026-07-22T00:00:03.000Z",
    }, state.options);
    await appendEvent(state.cpbRoot, "flow", jobId, {
      type: "finalizer_result",
      jobId,
      project: "flow",
      result: { ok: true, status: "closed", commit: "abc123" },
      ts: "2026-07-22T00:00:04.000Z",
    }, state.options);

    const job = await getJob(state.cpbRoot, "flow", jobId, state.options) as any;
    assert.equal(job.lastActivityMessage, "post-checkpoint truth");
    assert.equal(job.artifacts.pr, "review-report.json");
    assert.equal(job.pr.number, 17);
    assert.equal(job.finalizer.status, "closed");
    assert.equal(job.finalizer.commit, "abc123");
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("checkpointJob serializes its exact snapshot against a concurrent append", async () => {
  const jobId = "job-checkpoint-concurrent-append";
  const state = await fixture("cpb-checkpoint-concurrent-append-", jobId);
  const checkpoint = path.join(state.dataRoot, "checkpoints", "flow", `${jobId}.json`);
  const snapshotReady = deferred();
  const releaseSnapshot = deferred();
  try {
    await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options);
    await appendEvent(state.cpbRoot, "flow", jobId, jobCompleted(jobId), state.options);

    const checkpointPromise = withEventLockTestHooksForTests({
      afterCheckpointSnapshot: async ({ eventCount }) => {
        assert.equal(eventCount, 2);
        snapshotReady.resolve();
        await releaseSnapshot.promise;
      },
    }, () => checkpointJob(state.cpbRoot, "flow", jobId, state.options));
    await snapshotReady.promise;

    let appendSettled = false;
    const appendPromise = appendEvent(state.cpbRoot, "flow", jobId, {
      type: "phase_activity",
      jobId,
      project: "flow",
      message: "serialized suffix",
      ts: "2026-07-22T00:00:02.000Z",
    }, state.options).finally(() => { appendSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(appendSettled, false);

    releaseSnapshot.resolve();
    await checkpointPromise;
    await appendPromise;

    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(saved._meta.eventCount, 2);
    const job = await getJob(state.cpbRoot, "flow", jobId, state.options) as any;
    assert.equal(job.lastActivityMessage, "serialized suffix");
  } finally {
    releaseSnapshot.resolve();
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("getJob fails closed on malformed, ahead, or mismatched checkpoint cursors", async () => {
  const cases = [
    {
      name: "malformed",
      mutate(checkpoint: any) { checkpoint._meta.eventCount = "2"; },
      code: "CHECKPOINT_INVALID",
    },
    {
      name: "ahead",
      mutate(checkpoint: any) { checkpoint._meta.eventCount = 99; },
      code: "CHECKPOINT_CURSOR_AHEAD",
    },
    {
      name: "prefix-mismatch",
      mutate(checkpoint: any) { checkpoint._meta.eventDigest = "0".repeat(64); },
      code: "CHECKPOINT_EVENT_PREFIX_MISMATCH",
    },
    {
      name: "state-mismatch",
      mutate(checkpoint: any) { checkpoint.state.task = "forged checkpoint state"; },
      code: "CHECKPOINT_STATE_DIGEST_MISMATCH",
    },
    {
      name: "state-prefix-mismatch",
      mutate(checkpoint: any) {
        checkpoint.state.task = "forged checkpoint state with recomputed digest";
        checkpoint._meta.stateDigest = createHash("sha256")
          .update(JSON.stringify(checkpoint.state), "utf8")
          .digest("hex");
      },
      code: "CHECKPOINT_STATE_MISMATCH",
    },
  ];

  for (const hostile of cases) {
    const jobId = `job-checkpoint-${hostile.name}`;
    const state = await fixture(`cpb-checkpoint-${hostile.name}-`, jobId);
    const checkpointPath = path.join(state.dataRoot, "checkpoints", "flow", `${jobId}.json`);
    try {
      await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options);
      await appendEvent(state.cpbRoot, "flow", jobId, jobCompleted(jobId), state.options);
      await checkpointJob(state.cpbRoot, "flow", jobId, state.options);
      const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
      hostile.mutate(saved);
      await writeFile(checkpointPath, `${JSON.stringify(saved)}\n`, "utf8");

      await assert.rejects(
        () => getJob(state.cpbRoot, "flow", jobId, state.options),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, hostile.code, hostile.name);
          return true;
        },
      );
    } finally {
      await rm(state.cpbRoot, { recursive: true, force: true });
    }
  }
});

test("one jobs index refresh publishes an event appended after its optimistic read", async () => {
  const jobId = "job-index-projection-fence";
  const state = await fixture("cpb-index-projection-fence-", jobId);
  try {
    await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options);
    await appendEvent(state.cpbRoot, "flow", jobId, jobCompleted(jobId), state.options);
    await checkpointJob(state.cpbRoot, "flow", jobId, state.options);
    const original = await getJob(state.cpbRoot, "flow", jobId, state.options);
    assert.ok(original);

    const firstUpdate = withJobsIndexLockTestHooksForTests({
      afterProjectionRead: async ({ eventCount }) => {
        assert.equal(eventCount, 2);
        await appendEvent(state.cpbRoot, "flow", jobId, {
          type: "phase_activity",
          jobId,
          project: "flow",
          message: "newer indexed truth",
          ts: "2026-07-22T00:00:02.000Z",
        }, state.options);
      },
    }, () => updateJobsIndexEntry(state.cpbRoot, "flow", jobId, original, state.options));
    await firstUpdate;

    const index = await readJobsIndex(state.cpbRoot, state.options) as any;
    assert.equal(index.jobs[`flow/${jobId}`].lastActivityMessage, "newer indexed truth");
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("jobs index refresh fails closed within a bounded wait while the event stream remains locked", async () => {
  const jobId = "job-index-event-lock-busy";
  const state = await fixture("cpb-index-event-lock-busy-", jobId);
  const appendWritten = deferred();
  const releaseAppend = deferred();
  let pendingAppend: Promise<unknown> | null = null;
  try {
    await appendEvent(state.cpbRoot, "flow", jobId, jobCreated(jobId), state.options);
    await appendEvent(state.cpbRoot, "flow", jobId, jobCompleted(jobId), state.options);
    await checkpointJob(state.cpbRoot, "flow", jobId, state.options);
    const original = await getJob(state.cpbRoot, "flow", jobId, state.options);
    assert.ok(original);
    await updateJobsIndexEntry(state.cpbRoot, "flow", jobId, original, state.options);

    const appendPromise = withEventLockTestHooksForTests({
      afterAppendWrite: async () => {
        appendWritten.resolve();
        await releaseAppend.promise;
      },
    }, () => appendEvent(state.cpbRoot, "flow", jobId, {
      type: "phase_activity",
      jobId,
      project: "flow",
      message: "unpublished locked append",
      ts: "2026-07-22T00:00:02.000Z",
    }, state.options));
    pendingAppend = appendPromise;
    await appendWritten.promise;

    const startedAt = Date.now();
    await assert.rejects(
      withEventLockTestHooksForTests({ waitMs: 75 }, () => (
        updateJobsIndexEntry(state.cpbRoot, "flow", jobId, original, state.options)
      )),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "DIRECTORY_LOCK_BUSY");
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1_000);

    const index = await readJobsIndex(state.cpbRoot, state.options) as any;
    assert.equal(index.jobs[`flow/${jobId}`].lastActivityMessage, null);
    releaseAppend.resolve();
    await appendPromise;
  } finally {
    releaseAppend.resolve();
    await pendingAppend?.catch(() => {});
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEventIfCursor admits only one filesystem writer for the same cursor", async () => {
  const jobId = "journal-finalizer-cas";
  const state = await fixture("cpb-journal-finalizer-cas-", jobId);
  try {
    const initialCursor = await readEventStreamCursor(
      state.cpbRoot,
      "flow",
      jobId,
      state.options,
    );
    assert.equal(initialCursor.eventCount, 0);
    assert.match(initialCursor.eventDigest, /^[a-f0-9]{64}$/);

    const appendIntent = (intentId: string) => appendEventIfCursor(
      state.cpbRoot,
      "flow",
      jobId,
      {
        type: "finalizer_intent_created",
        project: "flow",
        jobId,
        intentId,
        ts: "2026-07-22T01:00:00.000Z",
      },
      initialCursor,
      state.options,
    );
    const results = await Promise.all([
      appendIntent("intent-writer-one"),
      appendIntent("intent-writer-two"),
    ]);

    const committed = results.filter((result) => result.committed);
    const conflicted = results.filter((result) => result.conflict);
    assert.equal(committed.length, 1);
    assert.equal(conflicted.length, 1);
    assert.equal(committed[0].conflict, false);
    assert.equal(conflicted[0].committed, false);

    const events = await readEvents(state.cpbRoot, "flow", jobId, state.options);
    assert.equal(events.length, 1);
    assert.match(String(events[0].intentId), /^intent-writer-(one|two)$/);
    const readbackCursor = await readEventStreamCursor(
      state.cpbRoot,
      "flow",
      jobId,
      state.options,
    );
    assert.deepEqual(committed[0].cursor, readbackCursor);
    assert.deepEqual(conflicted[0].cursor, readbackCursor);
    assert.equal(readbackCursor.eventCount, 1);
    assert.equal(await readJobsIndex(state.cpbRoot, state.options), null);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEventIfCursor exposes an exact readback cursor after ambiguous durability", async () => {
  const jobId = "journal-finalizer-ambiguous";
  const state = await fixture("cpb-journal-finalizer-ambiguous-", jobId);
  try {
    const initialCursor = await readEventStreamCursor(
      state.cpbRoot,
      "flow",
      jobId,
      state.options,
    );
    let failure: (Error & {
      code?: string;
      committed?: boolean | null;
      durabilityAmbiguous?: boolean;
      expectedCursor?: unknown;
      candidateCursor?: unknown;
    }) | null = null;

    await assert.rejects(
      withEventLockTestHooksForTests({
        beforeEventFileSync: ({ operation }) => {
          if (operation === "append") {
            throw Object.assign(new Error("injected conditional append fsync failure"), { code: "EIO" });
          }
        },
      }, () => appendEventIfCursor(
        state.cpbRoot,
        "flow",
        jobId,
        {
          type: "finalizer_intent_created",
          project: "flow",
          jobId,
          intentId: "intent-ambiguous",
          ts: "2026-07-22T01:01:00.000Z",
        },
        initialCursor,
        state.options,
      )),
      (error: Error & {
        code?: string;
        committed?: boolean | null;
        durabilityAmbiguous?: boolean;
        expectedCursor?: unknown;
        candidateCursor?: unknown;
      }) => {
        failure = error;
        assert.equal(error.code, "EVENT_APPEND_DURABILITY_AMBIGUOUS");
        assert.equal(error.committed, null);
        assert.equal(error.durabilityAmbiguous, true);
        assert.deepEqual(error.expectedCursor, initialCursor);
        return true;
      },
    );

    assert.ok(failure);
    const readbackCursor = await readEventStreamCursor(
      state.cpbRoot,
      "flow",
      jobId,
      state.options,
    );
    assert.deepEqual(failure.candidateCursor, readbackCursor);
    assert.equal(readbackCursor.eventCount, 1);

    const retry = await appendEventIfCursor(
      state.cpbRoot,
      "flow",
      jobId,
      {
        type: "finalizer_intent_created",
        project: "flow",
        jobId,
        intentId: "intent-stale-retry",
        ts: "2026-07-22T01:01:01.000Z",
      },
      initialCursor,
      state.options,
    );
    assert.deepEqual(retry, {
      committed: false,
      conflict: true,
      cursor: readbackCursor,
    });
    assert.equal((await readEvents(state.cpbRoot, "flow", jobId, state.options)).length, 1);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEventIfCursor uses Redis revision CAS without changing the stored projection", async () => {
  const jobId = "journal-finalizer-redis-cas";
  const state = await fixture("cpb-journal-finalizer-redis-cas-", jobId);
  const projection = Object.freeze({ status: "external-journal-projection" });
  const serializedEvents: string[] = [];
  const observedProjections: unknown[] = [];
  let revision = 7;
  let injectRevisionRace = true;
  let injectAmbiguousCommit = false;
  const competingEvent: EventRecord = {
    type: "finalizer_intent_created",
    project: "flow",
    jobId,
    intentId: "intent-redis-competitor",
    ts: "2026-07-22T01:02:00.000Z",
  };
  const redis = {
    async readStateRecord(_field: string) {
      return { revision, data: projection };
    },
    async readJobEvents(_field: string) {
      return [...serializedEvents];
    },
    async appendJobEvent(
      _field: string,
      expectedRevision: number,
      nextProjection: unknown,
      serializedEvent: string,
    ) {
      observedProjections.push(nextProjection);
      assert.strictEqual(nextProjection, projection);
      if (injectRevisionRace) {
        injectRevisionRace = false;
        revision += 1;
        serializedEvents.push(JSON.stringify(competingEvent));
        return { committed: false, revision, streamId: null };
      }
      if (expectedRevision !== revision) {
        return { committed: false, revision, streamId: null };
      }
      revision += 1;
      serializedEvents.push(serializedEvent);
      if (injectAmbiguousCommit) {
        injectAmbiguousCommit = false;
        throw Object.assign(new Error("injected Redis reply loss after commit"), {
          code: "HUB_STATE_BACKEND_UNAVAILABLE",
          commitOutcome: "unknown",
        });
      }
      return { committed: true, revision, streamId: `${revision}-0` };
    },
  };

  try {
    await withEventLockTestHooksForTests({
      openRedisEventBackend: async () => redis as any,
    }, async () => {
      const initialCursor = await readEventStreamCursor(
        state.cpbRoot,
        "flow",
        jobId,
        state.options,
      );
      const raced = await appendEventIfCursor(
        state.cpbRoot,
        "flow",
        jobId,
        {
          type: "finalizer_intent_created",
          project: "flow",
          jobId,
          intentId: "intent-lost-race",
          ts: "2026-07-22T01:02:01.000Z",
        },
        initialCursor,
        state.options,
      );
      assert.equal(raced.committed, false);
      assert.equal(raced.conflict, true);
      assert.equal(raced.cursor.eventCount, 1);

      const committed = await appendEventIfCursor(
        state.cpbRoot,
        "flow",
        jobId,
        {
          type: "finalizer_intent_created",
          project: "flow",
          jobId,
          intentId: "intent-after-race",
          ts: "2026-07-22T01:02:02.000Z",
        },
        raced.cursor,
        state.options,
      );
      assert.equal(committed.committed, true);
      assert.equal(committed.conflict, false);
      assert.equal(committed.cursor.eventCount, 2);
      assert.deepEqual(
        await readEventStreamCursor(state.cpbRoot, "flow", jobId, state.options),
        committed.cursor,
      );

      injectAmbiguousCommit = true;
      let ambiguousFailure: (Error & {
        code?: string;
        commitOutcome?: string;
        expectedCursor?: unknown;
        candidateCursor?: unknown;
      }) | null = null;
      await assert.rejects(
        () => appendEventIfCursor(
          state.cpbRoot,
          "flow",
          jobId,
          {
            type: "finalizer_intent_created",
            project: "flow",
            jobId,
            intentId: "intent-redis-ambiguous",
            ts: "2026-07-22T01:02:03.000Z",
          },
          committed.cursor,
          state.options,
        ),
        (error: Error & {
          code?: string;
          commitOutcome?: string;
          expectedCursor?: unknown;
          candidateCursor?: unknown;
        }) => {
          ambiguousFailure = error;
          assert.equal(error.code, "HUB_STATE_BACKEND_UNAVAILABLE");
          assert.equal(error.commitOutcome, "unknown");
          assert.deepEqual(error.expectedCursor, committed.cursor);
          return true;
        },
      );
      assert.ok(ambiguousFailure);
      assert.deepEqual(
        ambiguousFailure.candidateCursor,
        await readEventStreamCursor(state.cpbRoot, "flow", jobId, state.options),
      );
    });
    assert.equal(observedProjections.length, 3);
    assert.equal(revision, 10);
    assert.deepEqual(serializedEvents.map((value) => JSON.parse(value).intentId), [
      "intent-redis-competitor",
      "intent-after-race",
      "intent-redis-ambiguous",
    ]);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("appendEventIfCursor initializes a Redis-only external journal without a null job projection", async () => {
  const jobId = "finalizer-journal-empty-redis";
  const state = await fixture("cpb-journal-finalizer-empty-redis-", jobId);
  const serializedEvents: string[] = [];
  let revision = 0;
  let projection: unknown = null;
  const redis = {
    async readStateRecord(_field: string) {
      return { revision, data: projection };
    },
    async readJobEvents(_field: string) {
      return [...serializedEvents];
    },
    async appendJobEvent(
      _field: string,
      expectedRevision: number,
      nextProjection: unknown,
      serializedEvent: string,
    ) {
      assert.equal(expectedRevision, revision);
      assert.deepEqual(nextProjection, {
        schema: "cpb.external-event-journal.v1",
        project: "flow",
        jobId,
      });
      projection = nextProjection;
      revision += 1;
      serializedEvents.push(serializedEvent);
      return { committed: true, revision, streamId: `${revision}-0` };
    },
  };

  try {
    await withEventLockTestHooksForTests({
      openRedisEventBackend: async () => redis as any,
    }, async () => {
      const cursor = await readEventStreamCursor(state.cpbRoot, "flow", jobId, state.options);
      const result = await appendEventIfCursor(
        state.cpbRoot,
        "flow",
        jobId,
        {
          type: "finalizer_journal_claimed",
          project: "flow",
          jobId,
          ts: "2026-07-22T01:03:00.000Z",
        },
        cursor,
        { ...state.options, externalJournal: true },
      );
      assert.equal(result.committed, true);
      assert.equal(result.cursor.eventCount, 1);
    });
    assert.deepEqual(projection, {
      schema: "cpb.external-event-journal.v1",
      project: "flow",
      jobId,
    });
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});
