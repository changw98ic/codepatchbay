import assert from "node:assert/strict";
import { test } from "node:test";

import {
  discardBufferedEffects,
  replayBufferedEffects,
  type BufferedDagEffect,
} from "../core/engine/run-job-execute-dag.js";

function committedCleanupOutcome(cleanupPending: boolean, warnings: unknown[]) {
  const artifact = {
    kind: "review",
    id: "000001",
    name: "review-000001",
    path: "/tmp/review-000001.md",
    bytes: 1,
    sha256: "hash",
    metadata: {},
  };
  return {
    committed: true as const,
    artifact,
    cleanupPending,
    commitWarnings: warnings,
    retryCleanup: async () => artifact,
  };
}

function reservationEffect(
  name: string,
  calls: string[],
  options: { replayError?: Error; discardError?: Error } = {},
): BufferedDagEffect {
  return {
    kind: "artifact_write",
    eventType: null,
    publicationState: "buffered",
    reservationState: "reserved",
    async replay() {
      calls.push(`replay:${name}`);
      if (options.replayError) throw options.replayError;
    },
    async discard() {
      calls.push(`discard:${name}`);
      if (options.discardError) throw options.discardError;
    },
  };
}

test("discardBufferedEffects attempts every reservation and aggregates first and middle failures", async () => {
  const calls: string[] = [];
  const firstFailure = new Error("first reservation cleanup failed");
  const middleFailure = new Error("middle reservation cleanup failed");
  const effects = [
    reservationEffect("a", calls, { discardError: firstFailure }),
    reservationEffect("b", calls),
    reservationEffect("c", calls, { discardError: middleFailure }),
    reservationEffect("d", calls),
  ];

  await assert.rejects(discardBufferedEffects(effects), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors, [firstFailure, middleFailure]);
    assert.equal((error as AggregateError & { cause?: unknown }).cause, firstFailure);
    return true;
  });
  assert.deepEqual(calls, ["discard:a", "discard:b", "discard:c", "discard:d"]);
  assert.equal(effects[0].reservationState, "reserved");
  assert.equal(effects[1].reservationState, "settled");
  assert.equal(effects[2].reservationState, "reserved");
  assert.equal(effects[3].reservationState, "settled");
});

test("replayBufferedEffects stops publication on replay failure but discards every reservation", async () => {
  const calls: string[] = [];
  const replayFailure = new Error("second effect replay failed");
  const cleanupFailure = new Error("third reservation cleanup failed");
  const effects = [
    reservationEffect("a", calls),
    reservationEffect("b", calls, { replayError: replayFailure }),
    reservationEffect("c", calls, { discardError: cleanupFailure }),
    reservationEffect("d", calls),
  ];

  await assert.rejects(replayBufferedEffects(effects), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors, [replayFailure, cleanupFailure]);
    assert.equal((error as AggregateError & { cause?: unknown }).cause, replayFailure);
    return true;
  });
  assert.deepEqual(calls, [
    "replay:a",
    "replay:b",
    "discard:b",
    "discard:c",
    "discard:d",
  ]);
  assert.equal(effects[0].publicationState, "published");
  assert.equal(effects[1].publicationState, "buffered");
  assert.equal(effects[2].publicationState, "buffered");
  assert.equal(effects[3].publicationState, "buffered");
  assert.equal(effects[0].reservationState, "settled", "published artifact cleanup is still settled");
  assert.equal(effects[1].reservationState, "settled");
  assert.equal(effects[2].reservationState, "reserved", "failed cleanup remains retryable");
  assert.equal(effects[3].reservationState, "settled");
});

test("replayBufferedEffects records publication even when post-link cleanup remains retryable", async () => {
  const warning = new Error("temp unlink failed after hard-link publication");
  const effect = reservationEffect("published", []);
  effect.replay = async () => committedCleanupOutcome(true, [warning]);

  await replayBufferedEffects([effect]);

  assert.equal(effect.publicationState, "published");
  assert.equal(effect.reservationState, "reserved");
  assert.equal(effect.cleanupPending, true);
  assert.deepEqual(effect.commitWarnings, [warning]);
});

test("replayBufferedEffects settles a published artifact when cleanup only has a non-pending warning", async () => {
  const warning = new Error("post-link observer failed");
  const effect = reservationEffect("published", []);
  effect.replay = async () => committedCleanupOutcome(false, [warning]);

  await replayBufferedEffects([effect]);

  assert.equal(effect.publicationState, "published");
  assert.equal(effect.reservationState, "settled");
  assert.equal(effect.cleanupPending, false);
  assert.deepEqual(effect.commitWarnings, [warning]);
});

test("discardBufferedEffects keeps a committed reservation retryable instead of reporting discard success", async () => {
  const warning = new Error("cleanup still pending");
  const effect = reservationEffect("published-during-discard", []);
  effect.discard = async () => committedCleanupOutcome(true, [warning]);

  await discardBufferedEffects([effect]);

  assert.equal(effect.publicationState, "published");
  assert.equal(effect.reservationState, "reserved");
  assert.equal(effect.cleanupPending, true);
  assert.deepEqual(effect.commitWarnings, [warning]);
});
