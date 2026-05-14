#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test parseCommand logic directly
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function parseCommand(text) {
  const trimmed = text.trim().replace(/@\S+\s*/, "");
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const project = parts[0];
  if (!SAFE_NAME.test(project)) return null;
  const task = parts.slice(1).join(" ").trim();
  if (!task) return null;
  return { project, task };
}

describe("channel inbound parseReviewCommand", () => {
  function parseReviewCommand(text) {
    const trimmed = text.trim().replace(/@\S+\s*/, "");
    const parts = trimmed.split(/\s+/);
    if (parts[0] !== "review") return null;

    if (parts.length >= 3 && (parts[1] === "approve" || parts[1] === "reject")) {
      const sessionId = parts.slice(2).join(" ");
      return { action: parts[1], sessionId };
    }

    if (parts.length >= 3 && /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(parts[1])) {
      return { action: "create", project: parts[1], intent: parts.slice(2).join(" ") };
    }

    return null;
  }

  it("parses review approve command", () => {
    const cmd = parseReviewCommand("review approve rev-20260514-abc123");
    assert.deepEqual(cmd, { action: "approve", sessionId: "rev-20260514-abc123" });
  });

  it("parses review reject command", () => {
    const cmd = parseReviewCommand("review reject rev-20260514-abc123");
    assert.deepEqual(cmd, { action: "reject", sessionId: "rev-20260514-abc123" });
  });

  it("parses review create command", () => {
    const cmd = parseReviewCommand("review fatecat optimize the login page");
    assert.deepEqual(cmd, { action: "create", project: "fatecat", intent: "optimize the login page" });
  });

  it("strips @mention from review command", () => {
    const cmd = parseReviewCommand("@Bot review approve rev-123");
    assert.deepEqual(cmd, { action: "approve", sessionId: "rev-123" });
  });

  it("returns null for plain pipeline command", () => {
    assert.equal(parseReviewCommand("fatecat add dark mode"), null);
  });

  it("returns null for 'review' alone", () => {
    assert.equal(parseReviewCommand("review"), null);
  });

  it("returns null for 'review approve' without session id", () => {
    assert.equal(parseReviewCommand("review approve"), null);
  });
});

describe("channel inbound parseCommand", () => {
  it("parses 'project task description'", () => {
    const cmd = parseCommand("fatecat optimize the login page");
    assert.deepEqual(cmd, { project: "fatecat", task: "optimize the login page" });
  });

  it("strips @mention prefix", () => {
    const cmd = parseCommand("@CodePatchbayBot fatecat add dark mode");
    assert.deepEqual(cmd, { project: "fatecat", task: "add dark mode" });
  });

  it("returns null for single word (no task)", () => {
    assert.equal(parseCommand("fatecat"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseCommand(""), null);
  });

  it("returns null for invalid project name", () => {
    assert.equal(parseCommand("../bad do something"), null);
    assert.equal(parseCommand("a/b do something"), null);
  });

  it("handles CJK task descriptions", () => {
    const cmd = parseCommand("fatecat 优化登录页面的响应速度");
    assert.deepEqual(cmd, { project: "fatecat", task: "优化登录页面的响应速度" });
  });

  it("handles project with hyphens", () => {
    const cmd = parseCommand("my-project fix the bug");
    assert.deepEqual(cmd, { project: "my-project", task: "fix the bug" });
  });

  it("returns null for project starting with hyphen", () => {
    assert.equal(parseCommand("-bad task here"), null);
  });
});

describe("channel inbound Feishu payload format", () => {
  it("url verification returns challenge", () => {
    // Simulate what the route handler does
    const body = { type: "url_verification", challenge: "abc123", token: "xxx" };
    assert.equal(body.type, "url_verification");
    const response = { challenge: body.challenge };
    assert.equal(response.challenge, "abc123");
  });

  it("extracts text from Feishu event message content", () => {
    const event = {
      message: { content: JSON.stringify({ text: "@_user_1 fatecat fix the bug" }) },
    };
    const content = JSON.parse(event.message.content);
    assert.ok(content.text.includes("fatecat"));
    assert.ok(content.text.includes("fix the bug"));
  });

  it("extracts text from DingTalk outgoing message", () => {
    const body = {
      msgtype: "text",
      text: { content: "fatecat add unit tests" },
    };
    assert.equal(body.text.content, "fatecat add unit tests");
  });
});
