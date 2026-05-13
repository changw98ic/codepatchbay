#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireProviderSlot,
  releaseProviderSlot,
  listProviderSlots,
} from "../server/services/provider-semaphore.js";

const root = await mkdtemp(path.join(tmpdir(), "flow-provider-"));

const first = await acquireProviderSlot(root, {
  provider: "ollamacloud",
  jobId: "job-1",
  limit: 1,
});
assert.equal(first.acquired, true);
assert.equal(first.provider, "ollamacloud");
assert.equal(first.jobId, "job-1");

const second = await acquireProviderSlot(root, {
  provider: "ollamacloud",
  jobId: "job-2",
  limit: 1,
});
assert.equal(second.acquired, false);
assert.equal(second.provider, "ollamacloud");
assert.equal(second.jobId, "job-2");

await releaseProviderSlot(root, { provider: "ollamacloud", jobId: "job-1" });
const third = await acquireProviderSlot(root, {
  provider: "ollamacloud",
  jobId: "job-2",
  limit: 1,
});
assert.equal(third.acquired, true);

const slots = await listProviderSlots(root, "ollamacloud");
assert.equal(slots.length, 1);
assert.equal(slots[0].jobId, "job-2");

const emptySlots = await listProviderSlots(root, "unknown");
assert.equal(emptySlots.length, 0);

await releaseProviderSlot(root, { provider: "ollamacloud", jobId: "job-nonexistent" });

const differentProvider = await acquireProviderSlot(root, {
  provider: "openai",
  jobId: "job-3",
  limit: 2,
});
assert.equal(differentProvider.acquired, true);
const openaiSlots = await listProviderSlots(root, "openai");
assert.equal(openaiSlots.length, 1);

const limitTwo = await acquireProviderSlot(root, {
  provider: "openai",
  jobId: "job-4",
  limit: 2,
});
assert.equal(limitTwo.acquired, true);
const overLimit = await acquireProviderSlot(root, {
  provider: "openai",
  jobId: "job-5",
  limit: 2,
});
assert.equal(overLimit.acquired, false);
