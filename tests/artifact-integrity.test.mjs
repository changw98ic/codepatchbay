#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import {
  validateNonEmptyMarkdownArtifact,
  extractGithubIssueRefs,
  resolveDeliverableIssue,
  validateIssueMatch,
} from "../server/services/artifact-integrity.js";

// ---------------------------------------------------------------------------
// validateNonEmptyMarkdownArtifact
// ---------------------------------------------------------------------------
describe("validateNonEmptyMarkdownArtifact", () => {
  let tmp;

  test.before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cpb-integrity-"));
  });

  test.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("missing file returns { valid: false, reason: 'missing' }", async () => {
    const missing = path.join(tmp, "no-such-file.md");
    const result = await validateNonEmptyMarkdownArtifact({ path: missing, kind: "plan", id: "001" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "missing");
  });

  test("empty file (0 bytes) returns { valid: false, reason: 'empty_file' }", async () => {
    const empty = path.join(tmp, "empty.md");
    await writeFile(empty, "");
    const result = await validateNonEmptyMarkdownArtifact({ path: empty, kind: "plan", id: "001" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "empty_file");
  });

  test("whitespace-only file returns { valid: false, reason: 'whitespace_only' }", async () => {
    const ws = path.join(tmp, "whitespace.md");
    await writeFile(ws, "   \n\t  \n  ");
    const result = await validateNonEmptyMarkdownArtifact({ path: ws, kind: "plan", id: "001" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "whitespace_only");
  });

  test("valid markdown file returns { valid: true, content: '...' }", async () => {
    const md = path.join(tmp, "valid.md");
    const body = "# Hello\n\nSome content here.";
    await writeFile(md, body);
    const result = await validateNonEmptyMarkdownArtifact({ path: md, kind: "deliverable", id: "042" });
    assert.equal(result.valid, true);
    assert.equal(result.content, body);
    assert.equal(result.kind, "deliverable");
    assert.equal(result.id, "042");
  });
});

// ---------------------------------------------------------------------------
// extractGithubIssueRefs
// ---------------------------------------------------------------------------
describe("extractGithubIssueRefs", () => {
  test("empty/null input returns []", () => {
    assert.deepEqual(extractGithubIssueRefs(""), []);
    assert.deepEqual(extractGithubIssueRefs(null), []);
    assert.deepEqual(extractGithubIssueRefs(undefined), []);
  });

  test("extracts #123 style refs", () => {
    const result = extractGithubIssueRefs("Fix bug reported in #123 and #456");
    assert.deepEqual(result, [123, 456]);
  });

  test("extracts 'issue #456' style refs", () => {
    const result = extractGithubIssueRefs("Relates to issue #456");
    assert.deepEqual(result, [456]);
  });

  test("extracts full GitHub URLs", () => {
    const result = extractGithubIssueRefs("See github.com/owner/repo/issues/789 for details");
    assert.deepEqual(result, [789]);
  });

  test("deduplicates results", () => {
    const result = extractGithubIssueRefs("#100 and issue #100 and github.com/o/r/issues/100");
    assert.deepEqual(result, [100]);
  });
});

// ---------------------------------------------------------------------------
// resolveDeliverableIssue
// ---------------------------------------------------------------------------
describe("resolveDeliverableIssue", () => {
  test("null/empty input returns null", () => {
    assert.equal(resolveDeliverableIssue(null), null);
    assert.equal(resolveDeliverableIssue(""), null);
    assert.equal(resolveDeliverableIssue(undefined), null);
  });

  test("extracts issue from Task-Ref line within first 40 lines", () => {
    const content = [
      "# Deliverable",
      "",
      "Task-Ref: GitHub issue #32",
      "",
      "Some details here.",
    ].join("\n");
    assert.equal(resolveDeliverableIssue(content), 32);
  });

  test("extracts issue from heading '## Plan: GitHub issue #45'", () => {
    const content = [
      "# Deliverable",
      "",
      "## Plan: GitHub issue #45",
      "",
      "Body text.",
    ].join("\n");
    assert.equal(resolveDeliverableIssue(content), 45);
  });

  test("returns null when no issue refs found", () => {
    const content = "# Deliverable\n\nJust a regular document with no references.";
    assert.equal(resolveDeliverableIssue(content), null);
  });
});

// ---------------------------------------------------------------------------
// validateIssueMatch
// ---------------------------------------------------------------------------
describe("validateIssueMatch", () => {
  test("when expected is null, always returns { match: true }", () => {
    const result = validateIssueMatch({ expectedIssueNumber: null, artifactIssueNumber: 99 });
    assert.equal(result.match, true);
  });

  test("when both match, returns { match: true }", () => {
    const result = validateIssueMatch({ expectedIssueNumber: 42, artifactIssueNumber: 42 });
    assert.equal(result.match, true);
  });

  test("when they differ, returns { match: false, reason: 'issue_mismatch:...' }", () => {
    const result = validateIssueMatch({
      expectedIssueNumber: 10,
      artifactIssueNumber: 20,
      artifactPath: "/tmp/foo.md",
    });
    assert.equal(result.match, false);
    assert.ok(result.reason.includes("issue_mismatch"));
    assert.ok(result.reason.includes("#10"));
    assert.ok(result.reason.includes("#20"));
    assert.equal(result.expected, 10);
    assert.equal(result.actual, 20);
  });
});
