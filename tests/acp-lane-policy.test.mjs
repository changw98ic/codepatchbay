import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAcpProfile,
  resolveAcpLane,
  headlessCodexConfigArgs,
  classifyUiToolRequest,
  mergeHeadlessDenyTools,
  detectUiEscalation,
} from "../server/services/acp-lane-policy.js";

describe("acp-lane-policy", () => {
  describe("normalizeAcpProfile", () => {
    it("returns headless for undefined", () => {
      assert.equal(normalizeAcpProfile(undefined), "headless");
    });

    it("returns headless for null", () => {
      assert.equal(normalizeAcpProfile(null), "headless");
    });

    it("returns headless for empty string", () => {
      assert.equal(normalizeAcpProfile(""), "headless");
    });

    it("returns headless for 'headless'", () => {
      assert.equal(normalizeAcpProfile("headless"), "headless");
    });

    it("returns ui for 'ui'", () => {
      assert.equal(normalizeAcpProfile("ui"), "ui");
    });

    it("returns ui for 'UI' (case-insensitive)", () => {
      assert.equal(normalizeAcpProfile("UI"), "ui");
    });

    it("returns null for invalid value", () => {
      assert.equal(normalizeAcpProfile("invalid"), null);
    });
  });

  describe("resolveAcpLane", () => {
    it("defaults to headless when no profile given", () => {
      const result = resolveAcpLane();
      assert.deepEqual(result, { profile: "headless", uiLane: false, uiLaneReason: "" });
    });

    it("returns headless for explicit headless profile", () => {
      const result = resolveAcpLane({ profile: "headless" });
      assert.deepEqual(result, { profile: "headless", uiLane: false, uiLaneReason: "" });
    });

    it("returns error for ui profile without reason", () => {
      const result = resolveAcpLane({ profile: "ui" });
      assert.ok(result.error);
      assert.match(result.error, /uiLaneReason/);
    });

    it("returns ui lane with reason when provided", () => {
      const result = resolveAcpLane({ profile: "ui", uiLaneReason: "browser testing required" });
      assert.deepEqual(result, {
        profile: "ui",
        uiLane: true,
        uiLaneReason: "browser testing required",
      });
    });

    it("returns error for invalid profile", () => {
      const result = resolveAcpLane({ profile: "bogus" });
      assert.ok(result.error);
      assert.match(result.error, /invalid ACP profile/);
    });

    it("trims uiLaneReason whitespace", () => {
      const result = resolveAcpLane({ profile: "ui", uiLaneReason: "  needs browser  " });
      assert.equal(result.uiLaneReason, "needs browser");
    });
  });

  describe("headlessCodexConfigArgs", () => {
    it("returns config overrides for codex-acp command", () => {
      const args = headlessCodexConfigArgs("codex-acp");
      assert.ok(Array.isArray(args));
      assert.ok(args.length > 0);
      // Should contain plugin disable directives and notify=[]
      assert.ok(args.some((a) => a.includes("computer-use")));
      assert.ok(args.some((a) => a.includes("notify=[]")));
    });

    it("returns empty for path-prefixed codex-acp", () => {
      const args = headlessCodexConfigArgs("/usr/local/bin/codex-acp");
      assert.ok(Array.isArray(args));
      assert.ok(args.length > 0);
    });

    it("returns empty array for non-codex command", () => {
      const args = headlessCodexConfigArgs("claude-agent-acp");
      assert.deepEqual(args, []);
    });

    it("returns empty array for npx without codex-acp args", () => {
      const args = headlessCodexConfigArgs("npx", ["-y", "some-other-pkg"]);
      assert.deepEqual(args, []);
    });

    it("returns config overrides for npx with codex-acp args", () => {
      const args = headlessCodexConfigArgs("npx", ["-y", "@zed-industries/codex-acp"]);
      assert.ok(Array.isArray(args));
      assert.ok(args.length > 0);
      assert.ok(args.some((a) => a.includes("computer-use")));
      assert.ok(args.some((a) => a.includes("notify=[]")));
    });

    it("returns empty array for random command", () => {
      const args = headlessCodexConfigArgs("some-random-bin");
      assert.deepEqual(args, []);
    });
  });

  describe("classifyUiToolRequest", () => {
    it("detects computer-use method", () => {
      assert.equal(classifyUiToolRequest({ method: "computer-use" }), true);
    });

    it("detects browser method", () => {
      assert.equal(classifyUiToolRequest({ method: "browser" }), true);
    });

    it("detects chrome method", () => {
      assert.equal(classifyUiToolRequest({ method: "chrome" }), true);
    });

    it("detects desktop_automation method", () => {
      assert.equal(classifyUiToolRequest({ method: "desktop_automation" }), true);
    });

    it("detects computer_use method (underscore variant)", () => {
      assert.equal(classifyUiToolRequest({ method: "computer_use" }), true);
    });

    it("detects prefixed method computer-use/screenshot", () => {
      assert.equal(classifyUiToolRequest({ method: "computer-use/screenshot" }), true);
    });

    it("detects MCP-shaped request with serverName", () => {
      assert.equal(
        classifyUiToolRequest({ method: "tools/call", params: { serverName: "computer-use" } }),
        true,
      );
    });

    it("detects MCP-shaped request with mcpServerName", () => {
      assert.equal(
        classifyUiToolRequest({ method: "tools/call", params: { mcpServerName: "browser" } }),
        true,
      );
    });

    it("returns false for non-UI tool request", () => {
      assert.equal(classifyUiToolRequest({ method: "terminal/create" }), false);
    });

    it("returns false for null", () => {
      assert.equal(classifyUiToolRequest(null), false);
    });

    it("returns false for empty object", () => {
      assert.equal(classifyUiToolRequest({}), false);
    });

    it("returns false for non-object input", () => {
      assert.equal(classifyUiToolRequest("string"), false);
    });

    it("detects dot-prefixed .browser method", () => {
      assert.equal(classifyUiToolRequest({ method: ".browser" }), true);
    });

    it("detects dot-prefixed .computer-use method", () => {
      assert.equal(classifyUiToolRequest({ method: ".computer-use" }), true);
    });

    it("detects dot-prefixed .chrome.navigate method", () => {
      assert.equal(classifyUiToolRequest({ method: ".chrome.navigate" }), true);
    });

    it("detects dot-separated browser.navigate method", () => {
      assert.equal(classifyUiToolRequest({ method: "browser.navigate" }), true);
    });

    it("detects dot-separated computer.use.click method", () => {
      assert.equal(classifyUiToolRequest({ method: "computer.use.click" }), true);
    });

    it("detects dot-separated chrome.tab method", () => {
      assert.equal(classifyUiToolRequest({ method: "chrome.tab" }), true);
    });

    it("detects dot-separated desktop.screenshot method", () => {
      assert.equal(classifyUiToolRequest({ method: "desktop.screenshot" }), true);
    });

    it("detects bare computer.use method", () => {
      assert.equal(classifyUiToolRequest({ method: "computer.use" }), true);
    });

    it("detects bare browser method (exact alias)", () => {
      assert.equal(classifyUiToolRequest({ method: "browser" }), true);
    });

    it("returns false for dot-prefixed non-UI .terminal method", () => {
      assert.equal(classifyUiToolRequest({ method: ".terminal" }), false);
    });
  });

  describe("mergeHeadlessDenyTools", () => {
    it("returns UI tools when existing is empty", () => {
      const result = mergeHeadlessDenyTools("");
      assert.ok(result.length > 0);
      assert.ok(result.includes("computer-use"));
      assert.ok(result.includes("browser"));
      assert.ok(result.includes("chrome"));
      assert.ok(result.includes("desktop_automation"));
    });

    it("merges existing tools with UI tools", () => {
      const result = mergeHeadlessDenyTools("terminal/create,fs/delete");
      assert.ok(result.includes("terminal/create"));
      assert.ok(result.includes("fs/delete"));
      assert.ok(result.includes("computer-use"));
      assert.ok(result.includes("browser"));
    });

    it("deduplicates tools", () => {
      const result = mergeHeadlessDenyTools("browser,computer-use");
      // Should not have duplicates
      const tools = result.split(",");
      const unique = new Set(tools);
      assert.equal(tools.length, unique.size);
    });
  });

  describe("detectUiEscalation", () => {
    it("detects needs_ui_observation marker with reason", () => {
      const text = "Agent hit a wall: needs_ui_observation because browser needed to verify layout";
      const found = detectUiEscalation(text);
      assert.equal(found.length, 1);
      assert.equal(found[0].marker, "needs_ui_observation");
      assert.match(found[0].reason, /because browser needed to verify layout/);
    });

    it("detects multiple markers", () => {
      const text = "needs_ui_observation for screenshot\nalso blocked_requires_ui_lane due to chrome";
      const found = detectUiEscalation(text);
      assert.equal(found.length, 2);
    });

    it("detects needs_browser_check marker", () => {
      const found = detectUiEscalation("stuck: needs_browser_check to verify rendering");
      assert.equal(found.length, 1);
      assert.equal(found[0].marker, "needs_browser_check");
    });

    it("returns empty array for clean text", () => {
      const found = detectUiEscalation("everything is fine, no issues found");
      assert.deepEqual(found, []);
    });

    it("returns empty array for null", () => {
      assert.deepEqual(detectUiEscalation(null), []);
    });

    it("returns empty array for empty string", () => {
      assert.deepEqual(detectUiEscalation(""), []);
    });
  });
});
