import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSessionId, loadSessionId, clearSessionId } from "../core/agents/session-cache.js";

async function freshRoot() {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-sess-"));
  return { cpbRoot, dataRoot: path.join(cpbRoot, "data") };
}
const cleanup = (dir) => rm(dir, { recursive: true, force: true });

test("save→load round-trips sessionId for same agent+conversation", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "claude-glm", "sess-1", { dataRoot, conversationKey: "proj|job1|att0|executor" });
    const loaded = await loadSessionId(cpbRoot, "claude-glm", { dataRoot, conversationKey: "proj|job1|att0|executor" });
    assert.equal(loaded?.sessionId, "sess-1");
  } finally { await cleanup(cpbRoot); }
});

test("cache key includes agent: same conversation, different agent → null (handoff = new session)", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "claude-glm", "sess-1", { dataRoot, conversationKey: "k1" });
    const miss = await loadSessionId(cpbRoot, "claude-mimo", { dataRoot, conversationKey: "k1" });
    assert.equal(miss, null);
  } finally { await cleanup(cpbRoot); }
});

test("expiry: record older than maxAgeMs returns null", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "codex", "sess-old", { dataRoot, conversationKey: "k2" });
    const loaded = await loadSessionId(cpbRoot, "codex", {
      dataRoot, conversationKey: "k2", maxAgeMs: 1000, now: Date.now() + 60_000,
    });
    assert.equal(loaded, null);
  } finally { await cleanup(cpbRoot); }
});

test("clear removes the record", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "codex", "sess-3", { dataRoot, conversationKey: "k3" });
    await clearSessionId(cpbRoot, "codex", { dataRoot, conversationKey: "k3" });
    const loaded = await loadSessionId(cpbRoot, "codex", { dataRoot, conversationKey: "k3" });
    assert.equal(loaded, null);
  } finally { await cleanup(cpbRoot); }
});
