import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { waitForFinalResponse } from "../../core/agents/drivers/browser/response-waiter.mjs";

function makeMockLocator({ innerText = "", allInnerTexts = [], count = 1, visible = true, enabled = true } = {}) {
  return {
    all: async () => {
      if (count === 0) return [];
      return Array.from({ length: count }, () => ({
        locator: (sel) => ({
          allInnerTexts: async () => allInnerTexts,
        }),
        innerText: async () => innerText,
      }));
    },
    first: () => ({
      isEnabled: async () => enabled,
    }),
    count: async () => count,
    isVisible: async () => visible,
  };
}

function makeMockPage(opts = {}) {
  const {
    waitForSelectorResults = {},
    locatorResults = {},
    waitForTimeoutMs = 10,
  } = opts;

  return {
    locator: (sel) => {
      return locatorResults[sel] || makeMockLocator({ count: 0 });
    },
    waitForSelector: async (sel, { state, timeout }) => {
      const key = `${sel}:${state}`;
      if (waitForSelectorResults[key] === false) {
        throw new Error("timeout");
      }
    },
    waitForTimeout: async (ms) => {
      await new Promise((r) => setTimeout(r, Math.min(ms, waitForTimeoutMs)));
    },
    evaluate: async () => false,
  };
}

function makeProvider(overrides = {}) {
  return {
    input: {
      selector: "#input",
      submit: { mode: "button", selector: "#send" },
    },
    response: {
      messageSelector: ".message",
      textSelector: null,
      mode: "last-message",
      stableRounds: 2,
      minChars: 5,
      pollIntervalMs: 10,
      maxWaitMs: 5000,
      doneWhen: [{ type: "text-stable", rounds: 2 }],
      ...overrides.response,
    },
    continue: {
      enabled: false,
      selector: null,
      maxClicks: 5,
      cooldownMs: 10,
      ...overrides.continue,
    },
  };
}

describe("response-waiter: waitForFinalResponse", () => {
  it("returns text when text-stable condition is met", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "final answer" }),
      },
    });
    const provider = makeProvider();
    const result = await waitForFinalResponse(page, provider, { timeoutMs: 30000 });
    assert.equal(result.text, "final answer");
    assert.equal(result.stopObserved, false);
    assert.ok(result.elapsedMs >= 0);
  });

  it("returns via selector-hidden doneWhen", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "done via hidden" }),
      },
      waitForSelectorResults: {
        ".spinner:hidden": true,
      },
    });
    const provider = makeProvider({
      response: { doneWhen: [{ type: "selector-hidden", selector: ".spinner" }] },
    });
    const result = await waitForFinalResponse(page, provider, { timeoutMs: 30000 });
    assert.equal(result.text, "done via hidden");
  });

  it("returns via selector-visible doneWhen", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "done via visible" }),
      },
      waitForSelectorResults: {
        ".result:visible": true,
      },
    });
    const provider = makeProvider({
      response: { doneWhen: [{ type: "selector-visible", selector: ".result" }] },
    });
    const result = await waitForFinalResponse(page, provider, { timeoutMs: 30000 });
    assert.equal(result.text, "done via visible");
  });

  it("returns via send-enabled doneWhen when button is enabled", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "send enabled result" }),
        "#send": makeMockLocator({ enabled: true }),
      },
    });
    const provider = makeProvider({
      response: { doneWhen: [{ type: "send-enabled" }] },
    });
    const result = await waitForFinalResponse(page, provider, { timeoutMs: 30000 });
    assert.equal(result.text, "send enabled result");
  });

  it("times out and returns last text", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "partial" }),
      },
      waitForTimeoutMs: 5,
    });
    const provider = makeProvider({
      response: {
        pollIntervalMs: 10,
        maxWaitMs: 50,
        doneWhen: [{ type: "text-stable", rounds: 99 }], // Never stable
      },
    });
    const result = await waitForFinalResponse(page, provider, { timeoutMs: 100 });
    assert.equal(result.text, "partial");
    assert.ok(result.elapsedMs < 500);
  });

  it("observes stopObserved=true when signal is aborted", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "aborted" }),
      },
      waitForTimeoutMs: 5,
    });
    const provider = makeProvider({
      response: {
        pollIntervalMs: 10,
        maxWaitMs: 5000,
        doneWhen: [{ type: "text-stable", rounds: 99 }],
      },
    });
    const controller = new AbortController();
    const promise = waitForFinalResponse(page, provider, { signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    const result = await promise;
    assert.equal(result.text, "aborted");
    assert.equal(result.stopObserved, true);
  });

  it("counts continue clicks when continue is enabled", async () => {
    const page = makeMockPage({
      locatorResults: {
        ".message": makeMockLocator({ count: 1, innerText: "continue test" }),
        "#continue": makeMockLocator({ count: 1, visible: true }),
      },
    });
    const provider = makeProvider({
      response: { doneWhen: [{ type: "text-stable", rounds: 1 }] },
      continue: { enabled: true, selector: "#continue", maxClicks: 5, cooldownMs: 10 },
    });
    const result = await waitForFinalResponse(page, provider, { timeoutMs: 30000 });
    assert.equal(result.text, "continue test");
    assert.ok(result.continueClicks >= 0);
  });
});
