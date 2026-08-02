import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hashTaskKey,
  selectIdempotentEntry,
} from "../../core/contracts/idempotency.js";

test("task keys are stored as a known SHA-256 value instead of plaintext", () => {
  assert.equal(
    hashTaskKey("abc"),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a repeated submission reuses the existing in-flight task", () => {
  const key = hashTaskKey("project-a:add tests");
  const existing = {
    id: "task-1",
    status: "in_progress",
    metadata: { queueDedupeKey: key },
  };

  assert.equal(selectIdempotentEntry([existing], key), existing);
});

test("a completed task does not block a new submission", () => {
  const key = hashTaskKey("project-a:add tests");
  const completed = {
    id: "task-1",
    status: "completed",
    metadata: { queueDedupeKey: key },
  };

  assert.equal(selectIdempotentEntry([completed], key), null);
});
