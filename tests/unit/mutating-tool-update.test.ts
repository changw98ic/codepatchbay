import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isMutatingToolUpdate } from "../../server/services/acp/acp-client.js";

// --- isMutatingToolUpdate ---

describe("isMutatingToolUpdate", () => {
  // kind-based matching
  test("matches kind=edit", () => {
    assert.equal(isMutatingToolUpdate({ kind: "edit" }), true);
  });

  test("matches kind=write", () => {
    assert.equal(isMutatingToolUpdate({ kind: "write" }), true);
  });

  test("matches kind=multi_edit", () => {
    assert.equal(isMutatingToolUpdate({ kind: "multi_edit" }), true);
  });

  test("matches kind=mutation", () => {
    assert.equal(isMutatingToolUpdate({ kind: "mutation" }), true);
  });

  test("matches kind case-insensitively", () => {
    assert.equal(isMutatingToolUpdate({ kind: "Edit" }), true);
    assert.equal(isMutatingToolUpdate({ kind: "WRITE" }), true);
  });

  test("rejects kind=read", () => {
    assert.equal(isMutatingToolUpdate({ kind: "read" }), false);
  });

  test("rejects kind=search", () => {
    assert.equal(isMutatingToolUpdate({ kind: "search" }), false);
  });

  // title/toolName/serverName regex matching
  test("matches title containing Edit", () => {
    assert.equal(isMutatingToolUpdate({ title: "Edit file.txt" }), true);
  });

  test("matches toolName containing Write", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "Write" }), true);
  });

  test("matches title containing MultiEdit", () => {
    assert.equal(isMutatingToolUpdate({ title: "MultiEdit files" }), true);
  });

  // Apply Patch variants — the core fix for flow-9a0
  test("matches 'Apply Patch' with space", () => {
    assert.equal(isMutatingToolUpdate({ title: "Apply Patch" }), true);
  });

  test("matches 'apply_patch' with underscore", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "apply_patch" }), true);
  });

  test("matches 'Apply_Patch' mixed case underscore", () => {
    assert.equal(isMutatingToolUpdate({ title: "Apply_Patch" }), true);
  });

  test("matches 'apply patch' lowercase space", () => {
    assert.equal(isMutatingToolUpdate({ title: "apply patch" }), true);
  });

  // File write variants
  test("matches write_text_file", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "write_text_file" }), true);
  });

  test("matches fs/write_text_file", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "fs/write_text_file" }), true);
  });

  test("matches create_file", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "create_file" }), true);
  });

  test("matches write_file", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "write_file" }), true);
  });

  test("matches patch_file", () => {
    assert.equal(isMutatingToolUpdate({ toolName: "patch_file" }), true);
  });

  // Negative cases
  test("rejects read-only tools", () => {
    assert.equal(isMutatingToolUpdate({ kind: "read", title: "Read File" }), false);
    assert.equal(isMutatingToolUpdate({ kind: "search", title: "Grep" }), false);
    assert.equal(isMutatingToolUpdate({ title: "Search codebase" }), false);
    assert.equal(isMutatingToolUpdate({ toolName: "ls" }), false);
    assert.equal(isMutatingToolUpdate({ title: "cat file.txt" }), false);
  });

  test("rejects empty summary", () => {
    assert.equal(isMutatingToolUpdate({}), false);
  });

  test("rejects undefined summary", () => {
    assert.equal(isMutatingToolUpdate(), false);
  });

  // Combined fields
  test("matches when toolName is in combined text", () => {
    assert.equal(isMutatingToolUpdate({
      title: "some operation",
      toolName: "apply_patch",
      serverName: "codex",
    }), true);
  });
});
