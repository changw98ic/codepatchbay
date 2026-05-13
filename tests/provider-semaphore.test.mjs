#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireProviderSlot,
  cleanupStaleSlots,
  DEFAULT_SLOT_TTL_MS,
  listProviderSlots,
  releaseProviderSlot,
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

// --- Stale slot cleanup tests ---

const staleRoot = await mkdtemp(path.join(tmpdir(), "flow-provider-stale-"));

// Plant a stale slot manually (acquired 10 minutes ago, well past default 5min TTL)
const staleDir = path.join(staleRoot, ".omc", "provider-slots", "mistral");
const staleSlot = {
  provider: "mistral",
  jobId: "stale-job",
  acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
};
await import("node:fs/promises").then((fs) => fs.mkdir(staleDir, { recursive: true }));
await writeFile(path.join(staleDir, "stale-job.json"), JSON.stringify(staleSlot, null, 2));

// Plant a fresh slot
const freshSlot = {
  provider: "mistral",
  jobId: "fresh-job",
  acquiredAt: new Date().toISOString(),
};
await writeFile(path.join(staleDir, "fresh-job.json"), JSON.stringify(freshSlot, null, 2));

// cleanupStaleSlots should remove stale but keep fresh
const removed = await cleanupStaleSlots(staleRoot, { provider: "mistral", slotTtlMs: DEFAULT_SLOT_TTL_MS });
assert.equal(removed.length, 1);
assert.equal(removed[0].jobId, "stale-job");

const remaining = await listProviderSlots(staleRoot, "mistral");
assert.equal(remaining.length, 1);
assert.equal(remaining[0].jobId, "fresh-job");

// Stale slots should not count toward the limit during acquire
const staleRoot2 = await mkdtemp(path.join(tmpdir(), "flow-provider-stale2-"));
const staleDir2 = path.join(staleRoot2, ".omc", "provider-slots", "deepseek");
const staleSlot2 = {
  provider: "deepseek",
  jobId: "old-crash",
  acquiredAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
};
await import("node:fs/promises").then((fs) => fs.mkdir(staleDir2, { recursive: true }));
await writeFile(path.join(staleDir2, "old-crash.json"), JSON.stringify(staleSlot2, null, 2));

// Limit of 1, but the only slot is stale — acquire should succeed
const acquireAfterCrash = await acquireProviderSlot(staleRoot2, {
  provider: "deepseek",
  jobId: "new-job",
  limit: 1,
});
assert.equal(acquireAfterCrash.acquired, true);
assert.equal(acquireAfterCrash.jobId, "new-job");

// Verify only the new slot remains on disk
const deepseekSlots = await listProviderSlots(staleRoot2, "deepseek");
assert.equal(deepseekSlots.length, 1);
assert.equal(deepseekSlots[0].jobId, "new-job");

console.log("All tests passed.");
