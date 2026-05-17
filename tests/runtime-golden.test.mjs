import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { materializeJob } from "../server/services/event-store.js";

test("JS materializer keeps terminal-priority golden fixture stable", async () => {
  const raw = await readFile("tests/fixtures/runtime-events/terminal-priority.jsonl", "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));
  const state = materializeJob(events);

  assert.equal(state.status, "completed");
  assert.equal(state.phase, "completed");
  assert.equal(state.leaseId, null);
  assert.equal(state.lastActivityMessage, "late output");
});
