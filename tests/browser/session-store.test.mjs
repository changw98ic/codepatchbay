import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BrowserSessionManager } from "../../core/agents/drivers/browser/session-store.mjs";

describe("session-store: BrowserSessionManager", () => {
  let manager;
  let tempProfileDir;

  before(async () => {
    tempProfileDir = await mkdtemp(path.join(os.tmpdir(), "cpb-browser-session-"));
    manager = new BrowserSessionManager({ profileRoot: tempProfileDir });
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
    assert.ok(handle.profileDir.includes(tempProfileDir));
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

  it("uses separate runtime profiles for concurrent acquires of the same provider", async () => {
    const baseProfileDir = path.join(tempProfileDir, "mock", "profile-0");
    await mkdir(baseProfileDir, { recursive: true });
    await writeFile(path.join(baseProfileDir, "state.json"), '{"status":"ready"}', "utf8");

    const [h1, h2] = await Promise.all([
      manager.acquire({ providerName: "mock", sessionId: "parallel-1", headless: true }),
      manager.acquire({ providerName: "mock", sessionId: "parallel-2", headless: true }),
    ]);

    try {
      assert.notEqual(h1.profileDir, h2.profileDir);
      assert.equal(h1.baseProfileDir, baseProfileDir);
      assert.equal(h2.baseProfileDir, baseProfileDir);
      assert.ok(h1.profileDir.includes(path.join("mock", "runtime-profiles")));
      assert.ok(h2.profileDir.includes(path.join("mock", "runtime-profiles")));
      assert.equal(await readFile(path.join(h1.profileDir, "state.json"), "utf8"), '{"status":"ready"}');
      assert.equal(await readFile(path.join(h2.profileDir, "state.json"), "utf8"), '{"status":"ready"}');
    } finally {
      await Promise.all([manager.release(h1), manager.release(h2)]);
    }
  });

  it("promotes runtime storage state on successful release", async () => {
    const handle = await manager.acquire({
      providerName: "mock",
      sessionId: "promote-auth-state",
      headless: true,
    });

    await handle.context.addCookies([{
      name: "cpb_session",
      value: "fresh",
      domain: "example.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    }]);

    await manager.release(handle, { promoteAuthState: true });

    const statePath = path.join(handle.baseProfileDir, "auth-state.json");
    await access(statePath, constants.F_OK);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.cookies.find((cookie) => cookie.name === "cpb_session")?.value, "fresh");
  });

  it("closeProvider closes all contexts for a provider", async () => {
    const h1 = await manager.acquire({ providerName: "mock", sessionId: "s1", headless: true });
    await manager.release(h1);

    const h2 = await manager.acquire({ providerName: "mock", sessionId: "s2", headless: true });
    const h3 = await manager.acquire({ providerName: "chatgpt", sessionId: "s3", headless: true });

    assert.equal(manager.contexts.size, 2);
    await manager.closeProvider("mock");
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
