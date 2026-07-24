import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendEvent,
  appendEventIfCursor,
  eventFileFor,
  readEventStreamCursor,
  readEvents,
  withEventLockTestHooksForTests,
} from "../server/services/event/event-store.js";
import type { EventRecord } from "../server/services/event/event-types.js";

async function fixture(prefix: string, jobId: string) {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), prefix));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const options = { dataRoot };
  const file = eventFileFor(cpbRoot, "flow", jobId, options);
  return { cpbRoot, options, file };
}

function identityMismatch(error: Error & { code?: string; committed?: boolean }) {
  assert.equal(error.code, "EVENT_STREAM_IDENTITY_MISMATCH");
  assert.equal(error.committed, false);
  return true;
}

test("filesystem event appends bind missing identity and reject conflicting identity before writing", async () => {
  const jobId = "event-identity-filesystem";
  const state = await fixture("cpb-event-identity-fs-", jobId);
  try {
    await assert.rejects(
      () => appendEvent(state.cpbRoot, "flow", jobId, {
        type: "identity_probe",
        project: "other-project",
      }, state.options),
      identityMismatch,
    );
    await assert.rejects(readFile(state.file, "utf8"), { code: "ENOENT" });

    const first = await appendEvent(state.cpbRoot, "flow", jobId, {
      type: "identity_probe",
      ts: "2026-07-22T03:00:00.000Z",
    }, state.options);
    assert.equal(first?.project, "flow");
    assert.equal(first?.jobId, jobId);

    const cursor = await readEventStreamCursor(state.cpbRoot, "flow", jobId, state.options);
    await assert.rejects(
      () => appendEventIfCursor(state.cpbRoot, "flow", jobId, {
        type: "identity_probe_conditional",
        jobId: "different-job",
      }, cursor, state.options),
      identityMismatch,
    );

    const stored = (await readFile(state.file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].project, "flow");
    assert.equal(stored[0].jobId, jobId);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("filesystem reads reject an event that conflicts with its path identity", async () => {
  const jobId = "event-identity-read-filesystem";
  const state = await fixture("cpb-event-identity-read-fs-", jobId);
  try {
    await mkdir(path.dirname(state.file), { recursive: true });
    await writeFile(state.file, `${JSON.stringify({
      type: "identity_probe",
      project: "wrong-project",
      jobId,
    })}\n`, "utf8");

    await assert.rejects(
      () => readEvents(state.cpbRoot, "flow", jobId, state.options),
      identityMismatch,
    );
    await assert.rejects(
      () => readEventStreamCursor(state.cpbRoot, "flow", jobId, state.options),
      identityMismatch,
    );
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("a partial filesystem record is never reported as a committed event", async () => {
  const jobId = "event-partial-logical-write";
  const state = await fixture("cpb-event-partial-logical-write-", jobId);
  try {
    await assert.rejects(
      withEventLockTestHooksForTests({
        maxAppendWriteBytes: 8,
        afterAppendWriteChunk: () => {
          throw Object.assign(new Error("injected failure after partial event bytes"), { code: "EIO" });
        },
      }, () => appendEvent(state.cpbRoot, "flow", jobId, {
        type: "identity_probe_with_a_payload_longer_than_one_chunk",
        message: "this event must not be classified as logically committed",
      }, state.options)),
      (error: Error & {
        code?: string;
        committed?: boolean | null;
        durabilityAmbiguous?: boolean;
        partialWrite?: boolean;
        bytesWritten?: number;
        expectedBytes?: number;
      }) => {
        assert.equal(error.code, "EVENT_APPEND_PARTIAL_WRITE");
        assert.equal(error.committed, null);
        assert.equal(error.durabilityAmbiguous, true);
        assert.equal(error.partialWrite, true);
        assert.equal(error.bytesWritten, 8);
        assert.ok(Number(error.expectedBytes) > Number(error.bytesWritten));
        return true;
      },
    );
    assert.equal((await readFile(state.file)).byteLength, 8);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("Redis event appends bind identity and Redis reads reject cross-stream records", async () => {
  const jobId = "event-identity-redis";
  const state = await fixture("cpb-event-identity-redis-", jobId);
  const serializedEvents: string[] = [];
  let revision = 0;
  let projection: unknown = null;
  let writes = 0;
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
      projection = nextProjection;
      serializedEvents.push(serializedEvent);
      revision += 1;
      writes += 1;
      return { committed: true, revision, streamId: `${revision}-0` };
    },
  };

  try {
    await withEventLockTestHooksForTests({
      openRedisEventBackend: async () => redis as any,
    }, async () => {
      const written = await appendEvent(state.cpbRoot, "flow", jobId, {
        type: "job_created",
        task: "identity binding",
        workflow: "standard",
      }, state.options);
      assert.equal(written?.project, "flow");
      assert.equal(written?.jobId, jobId);
      assert.equal(JSON.parse(serializedEvents[0]!).project, "flow");
      assert.equal(JSON.parse(serializedEvents[0]!).jobId, jobId);

      await assert.rejects(
        () => appendEvent(state.cpbRoot, "flow", jobId, {
          type: "identity_probe",
          project: "wrong-project",
        }, state.options),
        identityMismatch,
      );
      assert.equal(writes, 1);

      projection = {
        schema: "cpb.external-event-journal.v1",
        project: "flow",
        jobId,
      };
      await assert.rejects(
        () => appendEvent(state.cpbRoot, "flow", jobId, {
          type: "identity_probe",
        }, state.options),
        (error: Error & { code?: string; committed?: boolean }) => {
          assert.equal(error.code, "JOB_PROJECTION_CONFLICT");
          assert.equal(error.committed, false);
          return true;
        },
      );
      assert.equal(writes, 1);

      serializedEvents.push(JSON.stringify({
        type: "identity_probe",
        project: "flow",
        jobId: "wrong-job",
      }));
      await assert.rejects(
        () => readEvents(state.cpbRoot, "flow", jobId, state.options),
        identityMismatch,
      );
    });
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("finalizer external journals persist the exact traced payload and reject rewritten payloads on FS and Redis", async () => {
  const fsJobId = "finalizer-journal-identity-fs";
  const fsState = await fixture("cpb-finalizer-journal-identity-fs-", fsJobId);
  try {
    const initial = await readEventStreamCursor(fsState.cpbRoot, "flow", fsJobId, fsState.options);
    const accepted = await appendEventIfCursor(
      fsState.cpbRoot,
      "flow",
      fsJobId,
      {
        type: "finalizer_journal_claimed",
        prPlan: { body: "safe release body" },
      },
      initial,
      { ...fsState.options, externalJournal: true },
    );
    assert.equal(accepted.committed, true);
    const stored = JSON.parse((await readFile(fsState.file, "utf8")).trim());
    assert.equal(stored.project, "flow");
    assert.equal(stored.jobId, fsJobId);
    assert.deepEqual(stored.prPlan, { body: "safe release body" });

    const beforeRejectedWrite = await readFile(fsState.file, "utf8");
    await assert.rejects(
      () => appendEvent(fsState.cpbRoot, "flow", fsJobId, {
        type: "foreign_job_event",
      }, fsState.options),
      (error: Error & { code?: string; committed?: boolean }) => {
        assert.equal(error.code, "JOB_PROJECTION_CONFLICT");
        assert.equal(error.committed, false);
        return true;
      },
    );
    await assert.rejects(
      () => appendEventIfCursor(
        fsState.cpbRoot,
        "flow",
        fsJobId,
        { type: "foreign_conditional_event" },
        accepted.cursor,
        fsState.options,
      ),
      (error: Error & { code?: string; committed?: boolean }) => {
        assert.equal(error.code, "JOB_PROJECTION_CONFLICT");
        assert.equal(error.committed, false);
        return true;
      },
    );
    assert.equal(await readFile(fsState.file, "utf8"), beforeRejectedWrite);

    await assert.rejects(
      () => appendEventIfCursor(
        fsState.cpbRoot,
        "flow",
        fsJobId,
        {
          type: "finalizer_journal_claimed",
          prPlan: { body: "token=example" },
        },
        accepted.cursor,
        { ...fsState.options, externalJournal: true },
      ),
      (error: Error & { code?: string; committed?: boolean }) => {
        assert.equal(error.code, "EXTERNAL_JOURNAL_PAYLOAD_REWRITE_REJECTED");
        assert.equal(error.committed, false);
        return true;
      },
    );
    assert.equal(await readFile(fsState.file, "utf8"), beforeRejectedWrite);
  } finally {
    await rm(fsState.cpbRoot, { recursive: true, force: true });
  }

  const redisJobId = "finalizer-journal-identity-redis";
  const redisState = await fixture("cpb-finalizer-journal-identity-redis-", redisJobId);
  const serializedEvents: string[] = [];
  let revision = 0;
  let projection: unknown = null;
  let writes = 0;
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
      projection = nextProjection;
      serializedEvents.push(serializedEvent);
      revision += 1;
      writes += 1;
      return { committed: true, revision, streamId: `${revision}-0` };
    },
  };

  try {
    await withEventLockTestHooksForTests({
      openRedisEventBackend: async () => redis as any,
    }, async () => {
      const initial = await readEventStreamCursor(
        redisState.cpbRoot,
        "flow",
        redisJobId,
        redisState.options,
      );
      const acceptedEvent: EventRecord = {
        type: "finalizer_journal_claimed",
        prPlan: { body: "safe release body" },
      };
      const accepted = await appendEventIfCursor(
        redisState.cpbRoot,
        "flow",
        redisJobId,
        acceptedEvent,
        initial,
        { ...redisState.options, externalJournal: true },
      );
      assert.equal(accepted.committed, true);
      const stored = JSON.parse(serializedEvents[0]!);
      assert.equal(stored.project, "flow");
      assert.equal(stored.jobId, redisJobId);
      assert.deepEqual(stored.prPlan, acceptedEvent.prPlan);

      await assert.rejects(
        () => appendEventIfCursor(
          redisState.cpbRoot,
          "flow",
          redisJobId,
          {
            type: "finalizer_journal_claimed",
            project: "wrong-project",
          },
          accepted.cursor,
          { ...redisState.options, externalJournal: true },
        ),
        identityMismatch,
      );
      assert.equal(writes, 1);

      await assert.rejects(
        () => appendEventIfCursor(
          redisState.cpbRoot,
          "flow",
          redisJobId,
          {
            type: "finalizer_journal_claimed",
            prPlan: { body: "token=example" },
          },
          accepted.cursor,
          { ...redisState.options, externalJournal: true },
        ),
        (error: Error & { code?: string; committed?: boolean }) => {
          assert.equal(error.code, "EXTERNAL_JOURNAL_PAYLOAD_REWRITE_REJECTED");
          assert.equal(error.committed, false);
          return true;
        },
      );
      assert.equal(writes, 1);
      assert.equal(serializedEvents.length, 1);
    });
  } finally {
    await rm(redisState.cpbRoot, { recursive: true, force: true });
  }
});
