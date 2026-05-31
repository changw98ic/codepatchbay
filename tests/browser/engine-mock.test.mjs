import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

let executeBrowserAgent;
let tempProfileDir;

describe("engine: executeBrowserAgent with mock provider", () => {
  before(async () => {
    tempProfileDir = await mkdtemp(path.join(os.tmpdir(), "cpb-engine-mock-"));
    process.env.CPB_ACP_BROWSER_AGENT_PROFILE_ROOT = tempProfileDir;
    const mod = await import("../../core/agents/drivers/browser/engine.mjs");
    executeBrowserAgent = mod.executeBrowserAgent;
  });

  after(async () => {
    delete process.env.CPB_ACP_BROWSER_AGENT_PROFILE_ROOT;
    try {
      await rm(tempProfileDir, { recursive: true, force: true });
    } catch {}
  });

  it("sends prompt and receives expected mock response", async () => {
    const result = await executeBrowserAgent({
      providerName: "mock",
      prompt: '{"status":"ok","message":"browser-agent-ready"}',
      timeoutMs: 30000,
      headless: true,
      trace: false,
    });

    assert.ok(result.text.includes('"status":"ok"') || result.text.includes("browser-agent-ready"),
      `expected mock response, got: ${result.text.slice(0, 200)}`);

    assert.equal(typeof result.diagnostics.provider, "string");
    assert.equal(result.diagnostics.provider, "mock");
    assert.ok(typeof result.diagnostics.elapsedMs === "number");
    assert.ok(result.diagnostics.elapsedMs >= 0);
    assert.equal(typeof result.diagnostics.responseChars, "number");
    assert.ok(result.diagnostics.responseChars > 0);
    assert.equal(typeof result.diagnostics.continueClicks, "number");
    assert.ok(result.diagnostics.profileDir.includes("mock"));
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    const promise = executeBrowserAgent({
      providerName: "mock",
      prompt: "test abort",
      timeoutMs: 60000,
      headless: true,
      signal: controller.signal,
    });

    // Abort shortly after launch
    setTimeout(() => controller.abort(), 500);

    await assert.rejects(async () => promise, (err) => {
      assert.ok(err.message === "Aborted" || err.name === "AbortError");
      return true;
    });
  });
});
