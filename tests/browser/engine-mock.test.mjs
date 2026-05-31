import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { executeBrowserAgent } from "../../core/agents/drivers/browser/engine.mjs";

const FIXTURE_URL = "file://" + path.resolve(
  import.meta.dirname,
  "../../core/agents/drivers/browser/fixtures/pages/mock-chat.html"
);

describe("engine: executeBrowserAgent with mock provider", () => {
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
