import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { saveSessionId, loadSessionId, clearSessionId, cleanupSessionCache } from "../core/agents/session-cache.js";

describe("session cache", () => {
  let cpbRoot;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-sess-"));
  });

  afterEach(async () => {
    await rm(cpbRoot, { recursive: true, force: true });
  });

  it("saveSessionId writes JSON file", async () => {
    await saveSessionId(cpbRoot, "claude", "sess-abc-123");
    const raw = await readFile(
      path.join(cpbRoot, "cpb-task", "session-cache", "claude.json"),
      "utf8",
    );
    const data = JSON.parse(raw);
    assert.equal(data.agent, "claude");
    assert.equal(data.sessionId, "sess-abc-123");
    assert.ok(data.savedAt);
  });

  it("loadSessionId returns saved data", async () => {
    await saveSessionId(cpbRoot, "codex", "sess-xyz-456", { jobPhase: "execute" });
    const data = await loadSessionId(cpbRoot, "codex");
    assert.ok(data);
    assert.equal(data.sessionId, "sess-xyz-456");
    assert.equal(data.agent, "codex");
    assert.equal(data.jobPhase, "execute");
  });

  it("loadSessionId returns null for missing agent", async () => {
    const data = await loadSessionId(cpbRoot, "nonexistent");
    assert.equal(data, null);
  });

  it("loadSessionId returns null for expired cache", async () => {
    await saveSessionId(cpbRoot, "claude", "sess-old");
    // maxAgeMs=1 + now 1s in future => expired
    const data = await loadSessionId(cpbRoot, "claude", { maxAgeMs: 1, now: Date.now() + 1000 });
    assert.equal(data, null);
  });

  it("saveSessionId overwrites previous session", async () => {
    await saveSessionId(cpbRoot, "claude", "sess-v1");
    await saveSessionId(cpbRoot, "claude", "sess-v2");
    const data = await loadSessionId(cpbRoot, "claude");
    assert.equal(data.sessionId, "sess-v2");
  });

  it("clearSessionId removes cached session", async () => {
    await saveSessionId(cpbRoot, "codex", "sess-to-delete");
    await clearSessionId(cpbRoot, "codex");
    const data = await loadSessionId(cpbRoot, "codex");
    assert.equal(data, null);
  });

  it("clearSessionId handles missing file gracefully", async () => {
    await clearSessionId(cpbRoot, "nonexistent");
    // Should not throw
  });

  it("cleanupSessionCache removes expired entries", async () => {
    await saveSessionId(cpbRoot, "claude", "sess-1");
    await saveSessionId(cpbRoot, "codex", "sess-2");

    // maxAgeMs=1 + now in future => everything is expired
    const cleaned = await cleanupSessionCache(cpbRoot, { maxAgeMs: 1, now: Date.now() + 1000 });
    assert.ok(cleaned >= 2, `should clean at least 2, got ${cleaned}`);
  });

  it("cleanupSessionCache preserves recent entries", async () => {
    await saveSessionId(cpbRoot, "claude", "sess-recent");

    const cleaned = await cleanupSessionCache(cpbRoot, { maxAgeMs: 24 * 60 * 60 * 1000 });
    assert.equal(cleaned, 0);

    const data = await loadSessionId(cpbRoot, "claude");
    assert.ok(data);
    assert.equal(data.sessionId, "sess-recent");
  });

  it("cleanupSessionCache handles empty root gracefully", async () => {
    const cleaned = await cleanupSessionCache(cpbRoot);
    assert.equal(cleaned, 0);
  });
});

describe("descriptor lifecycle fields", () => {
  it("builtin descriptors have lifecycle fields", async () => {
    const reg = await import("../core/agents/registry.js");
    await reg.loadRegistry();

    for (const name of ["claude", "codex"]) {
      const desc = reg.getDescriptor(name);
      assert.ok(desc, `${name} should be in registry`);
      assert.ok(
        desc.lifecycle === "one-shot" || desc.lifecycle === "persistent" || desc.lifecycle === "cached",
        `${name} lifecycle should be valid, got: ${desc.lifecycle}`,
      );
      assert.ok(typeof desc.resumeCommand === "string", `${name} should have resumeCommand`);
      assert.ok(Array.isArray(desc.resumeArgs), `${name} should have resumeArgs array`);
    }
  });
});
