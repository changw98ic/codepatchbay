import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimatePromptBytes,
  clipTextByBytes,
  buildBudgetReport,
} from "../server/services/prompt-budget.js";

describe("estimatePromptBytes", () => {
  it("returns correct byte length for ASCII", () => {
    assert.equal(estimatePromptBytes("hello"), 5);
    assert.equal(estimatePromptBytes("abc\n123"), 7);
  });

  it("returns correct byte length for multibyte", () => {
    // "你好" = 6 bytes in UTF-8 (3 bytes per CJK character)
    assert.equal(estimatePromptBytes("你好"), 6);
    // Mixed: "a你b" = 1 + 3 + 1 = 5
    assert.equal(estimatePromptBytes("a你b"), 5);
  });
});

describe("clipTextByBytes", () => {
  it("clips at newline boundary", () => {
    const text = "line1\nline2\nline3\nline4";
    // "line1\nline2\n" = 12 bytes, "line1\nline2\nline3\n" = 18 bytes
    const result = clipTextByBytes(text, 14);
    assert.equal(result.text, "line1\nline2\n");
    assert.equal(result.clipped, true);
  });

  it("returns full text when under maxBytes", () => {
    const text = "short text";
    const result = clipTextByBytes(text, 100);
    assert.equal(result.text, text);
    assert.equal(result.clipped, false);
    assert.equal(result.originalBytes, result.resultBytes);
  });

  it("sets clipped=true when text is clipped", () => {
    const text = "a very long string that exceeds the budget";
    const result = clipTextByBytes(text, 10);
    assert.equal(result.clipped, true);
    assert.ok(result.resultBytes <= 10);
    assert.ok(result.originalBytes > 10);
  });
});

describe("buildBudgetReport", () => {
  it("includes all required sections even if over maxBytes", () => {
    const sections = [
      { name: "system", content: "x".repeat(100), required: true },
      { name: "task", content: "y".repeat(100), required: true },
    ];
    const report = buildBudgetReport(sections, 50);
    assert.equal(report.sections[0].included, true);
    assert.equal(report.sections[1].included, true);
    assert.equal(report.clipped, true);
  });

  it("drops optional sections when budget exceeded", () => {
    const sections = [
      { name: "system", content: "x".repeat(80), required: true },
      { name: "index", content: "y".repeat(80), required: false },
    ];
    const report = buildBudgetReport(sections, 100);
    assert.equal(report.sections[0].included, true);
    assert.equal(report.sections[1].included, false);
  });

  it("includes optional sections when budget available", () => {
    const sections = [
      { name: "system", content: "x".repeat(20), required: true },
      { name: "index", content: "y".repeat(20), required: false },
    ];
    const report = buildBudgetReport(sections, 100);
    assert.equal(report.sections[0].included, true);
    assert.equal(report.sections[1].included, true);
    assert.equal(report.clipped, false);
  });

  it("report has correct section names and byte counts", () => {
    const content = "hello world";
    const sections = [
      { name: "instructions", content, required: true },
    ];
    const report = buildBudgetReport(sections, 1000);
    assert.equal(report.sections[0].name, "instructions");
    assert.equal(report.sections[0].bytes, Buffer.byteLength(content, "utf8"));
    assert.equal(report.sections[0].included, true);
    assert.equal(report.totalBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(report.maxBytes, 1000);
  });
});
