import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BrowserSessionManager } from "../../core/agents/drivers/browser/session-store.mjs";

describe("session-store: BrowserSessionManager", () => {
  let manager;
  let tempProfileDir;

  before(async () => {
    manager = new BrowserSessionManager();
    tempProfileDir = await mkdtemp(path.join(os.tmpdir(), "cpb-browser-session-"));
  });

  after(async () => {
    await manager.shutdown();
    try {
      await rm(tempProfileDir, { recursive: true, force: true });
    } catch {}
  });

  it("acquire returns a context handle with id", async () => {
    const handle = await manager.acquire({
      providerName: "mock",
      sessionId: "test-session-1",
      role: "test",
      project: "test-project",
      headless: true,
    });
    assert.ok(handle.id);
    assert.equal(handle.providerName, "mock");
    assert.equal(handle.role, "test");
    assert.equal(handle.project, "test-project");
    assert.ok(handle.context);
    assert.ok(handle.page);
    assert.equal(typeof handle.createdAt, "number");
    await manager.release(handle);
  });

  it("release removes handle from contexts map and closes context", async () => {
    const handle = await manager.acquire({
      providerName: "mock",
      sessionId: "test-session-2",
      headless: true,
    });
    assert.ok(manager.contexts.has(handle.id));
    await manager.release(handle);
    assert.equal(manager.contexts.has(handle.id), false);
  });

  it("release is safe on null handle", async () => {
    await assert.doesNotReject(async () => manager.release(null));
  });

  it("closeProvider closes all contexts for a provider", async () => {
    const h1 = await manager.acquire({ providerName: "mock", sessionId: "s1", headless: true });
    const h2 = await manager.acquire({ providerName: "mock", sessionId: "s2", headless: true });
    const h3 = await manager.acquire({ providerName: "chatgpt", sessionId: "s3", headless: true });

    assert.equal(manager.contexts.size, 3);
    await manager.closeProvider("mock");
    assert.equal(manager.contexts.has(h1.id), false);
    assert.equal(manager.contexts.has(h2.id), false);
    assert.equal(manager.contexts.has(h3.id), true);

    await manager.release(h3);
  });

  it("shutdown closes all contexts", async () => {
    const h1 = await manager.acquire({ providerName: "mock", sessionId: "s4", headless: true });
    const h2 = await manager.acquire({ providerName: "chatgpt", sessionId: "s5", headless: true });
    assert.equal(manager.contexts.size, 2);
    await manager.shutdown();
    assert.equal(manager.contexts.size, 0);
  });
});
