import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopDetector, createDetectorFromEnv } from "../bridges/tool-loop-detector.mjs";

describe("ToolLoopDetector", () => {
  it("returns null when no loop detected", () => {
    const d = new ToolLoopDetector();
    assert.equal(d.record("fs/read_text_file", { path: "/a" }, "/cwd"), null);
    assert.equal(d.record("fs/write_text_file", { path: "/b" }, "/cwd"), null);
    assert.equal(d.record("fs/read_text_file", { path: "/c" }, "/cwd"), null);
  });

  it("detects consecutive identical tool calls", () => {
    const alerts = [];
    const d = new ToolLoopDetector({
      threshold: 3,
      onAlert: (a) => alerts.push(a),
    });

    d.record("fs/read_text_file", { path: "/same" }, "/cwd");
    d.record("fs/read_text_file", { path: "/same" }, "/cwd");

    // 2 identical — not yet at threshold
    assert.equal(alerts.length, 0);

    const alert = d.record("fs/read_text_file", { path: "/same" }, "/cwd");
    assert.ok(alert);
    assert.equal(alert.type, "tool_loop");
    assert.equal(alert.method, "fs/read_text_file");
    assert.equal(alert.consecutiveCalls, 3);
    assert.equal(alerts.length, 1);
  });

  it("does not alert when params differ", () => {
    const d = new ToolLoopDetector({ threshold: 3 });
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/b" }, "/cwd");
    d.record("fs/read_text_file", { path: "/c" }, "/cwd");
    assert.equal(d.getAlerts().length, 0);
  });

  it("does not alert when cwd differs", () => {
    const d = new ToolLoopDetector({ threshold: 3 });
    d.record("fs/read_text_file", { path: "/a" }, "/cwd1");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd2");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd3");
    assert.equal(d.getAlerts().length, 0);
  });

  it("resets counter when a different tool breaks the streak", () => {
    const d = new ToolLoopDetector({ threshold: 3 });
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/write_text_file", { path: "/b" }, "/cwd"); // breaks streak
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    assert.equal(d.getAlerts().length, 0);
  });

  it("respects window size", () => {
    const d = new ToolLoopDetector({ threshold: 3, windowSize: 5 });
    // Fill window with 5 different calls
    for (let i = 0; i < 5; i++) {
      d.record("fs/read_text_file", { path: `/file-${i}` }, "/cwd");
    }
    // Now add 3 identical — the old entries are evicted
    d.record("terminal/create", { command: "ls" }, "/cwd");
    d.record("terminal/create", { command: "ls" }, "/cwd");
    const alert = d.record("terminal/create", { command: "ls" }, "/cwd");
    assert.ok(alert);
    assert.equal(alert.consecutiveCalls, 3);
  });

  it("reset clears state", () => {
    const d = new ToolLoopDetector({ threshold: 3 });
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    assert.equal(d.getAlerts().length, 1);

    d.reset();
    assert.equal(d.getAlerts().length, 0);
    assert.equal(d.record("fs/read_text_file", { path: "/a" }, "/cwd"), null);
  });

  it("getAlerts returns a copy", () => {
    const d = new ToolLoopDetector({ threshold: 3 });
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    d.record("fs/read_text_file", { path: "/a" }, "/cwd");
    const a1 = d.getAlerts();
    const a2 = d.getAlerts();
    assert.notEqual(a1, a2);
    assert.deepEqual(a1, a2);
  });
});

describe("createDetectorFromEnv", () => {
  it("returns null when flag is not set", () => {
    assert.equal(createDetectorFromEnv({}), null);
    assert.equal(createDetectorFromEnv({ CPB_TOOL_LOOP_DETECTOR: "0" }), null);
  });

  it("creates detector when flag is set", () => {
    const d = createDetectorFromEnv({ CPB_TOOL_LOOP_DETECTOR: "1" });
    assert.ok(d instanceof ToolLoopDetector);
  });

  it("respects custom threshold and window", () => {
    const d = createDetectorFromEnv({
      CPB_TOOL_LOOP_DETECTOR: "1",
      CPB_TOOL_LOOP_THRESHOLD: "5",
      CPB_TOOL_LOOP_WINDOW: "20",
    });
    assert.ok(d instanceof ToolLoopDetector);
    assert.equal(d.threshold, 5);
    assert.equal(d.windowSize, 20);
  });
});
