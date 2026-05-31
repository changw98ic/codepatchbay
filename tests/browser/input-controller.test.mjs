import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fillPrompt, submitPrompt } from "../../core/agents/drivers/browser/input-controller.mjs";

function makeMockLocator(calls) {
  return {
    first: () => ({
      fill: async (text) => calls.push({ method: "fill", text }),
      type: async (text) => calls.push({ method: "type", text }),
      click: async () => calls.push({ method: "click" }),
    }),
  };
}

function makeMockPage(calls) {
  return {
    locator: (sel) => makeMockLocator(calls),
    keyboard: {
      press: async (key) => calls.push({ method: "press", key }),
    },
    evaluate: async (fn, ...args) => {
      if (typeof fn === "function" && fn.toString().includes("MAC")) {
        calls.push({ method: "evaluate", topic: "platform" });
        return false; // Non-Mac
      }
      calls.push({ method: "evaluate", topic: "paste", args });
      return undefined;
    },
  };
}

describe("input-controller: fillPrompt", () => {
  it("fill method calls el.fill with prompt", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#input",
        kind: "textarea",
        method: "fill",
        clearBeforeInput: false,
      },
    };
    await fillPrompt(page, provider, "hello world");
    assert.equal(calls.filter((c) => c.method === "fill" && c.text === "hello world").length, 1);
  });

  it("clearBeforeInput=true calls fill('') before fill(prompt)", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#input",
        kind: "textarea",
        method: "fill",
        clearBeforeInput: true,
      },
    };
    await fillPrompt(page, provider, "hello");
    const fills = calls.filter((c) => c.method === "fill");
    assert.equal(fills.length, 2);
    assert.equal(fills[0].text, "");
    assert.equal(fills[1].text, "hello");
  });

  it("type method calls el.type with prompt", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#input",
        kind: "contenteditable",
        method: "type",
        clearBeforeInput: false,
      },
    };
    await fillPrompt(page, provider, "test prompt");
    assert.equal(calls.filter((c) => c.method === "type" && c.text === "test prompt").length, 1);
  });

  it("paste method calls evaluate with selector and text", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#editor",
        kind: "contenteditable",
        method: "paste",
        clearBeforeInput: true,
      },
    };
    await fillPrompt(page, provider, "pasted text");
    assert.equal(calls.filter((c) => c.method === "evaluate" && c.topic === "paste").length, 1);
    assert.equal(calls.filter((c) => c.method === "fill" && c.text === "").length, 2);
  });
});

describe("input-controller: submitPrompt", () => {
  it("button mode clicks the submit button", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#input",
        submit: { mode: "button", selector: "#send" },
      },
    };
    await submitPrompt(page, provider);
    assert.equal(calls.filter((c) => c.method === "click").length, 1);
  });

  it("enter mode presses Enter", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#input",
        submit: { mode: "enter" },
      },
    };
    await submitPrompt(page, provider);
    assert.equal(calls.filter((c) => c.method === "press" && c.key === "Enter").length, 1);
  });

  it("mod-enter mode presses Control+Enter on non-Mac", async () => {
    const calls = [];
    const page = makeMockPage(calls);
    const provider = {
      input: {
        selector: "#input",
        submit: { mode: "mod-enter" },
      },
    };
    await submitPrompt(page, provider);
    assert.equal(calls.filter((c) => c.method === "press" && c.key === "Control+Enter").length, 1);
  });

  it("mod-enter mode presses Meta+Enter on Mac", async () => {
    const calls = [];
    const page = {
      locator: (sel) => makeMockLocator(calls),
      keyboard: {
        press: async (key) => calls.push({ method: "press", key }),
      },
      evaluate: async () => true, // Mac
    };
    const provider = {
      input: {
        selector: "#input",
        submit: { mode: "mod-enter" },
      },
    };
    await submitPrompt(page, provider);
    assert.equal(calls.filter((c) => c.method === "press" && c.key === "Meta+Enter").length, 1);
  });
});
