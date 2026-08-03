import assert from "node:assert/strict";
import { test } from "node:test";

import {
  stripGitStatusPrefix,
  validateScopeConstraint,
  evaluateScopeGuard,
  normalizeRepoRelativePaths,
} from "../../core/engine/scope-guard.js";

// ---------------------------------------------------------------------------
// stripGitStatusPrefix
// ---------------------------------------------------------------------------

test("stripGitStatusPrefix returns clean paths unchanged", () => {
  assert.equal(stripGitStatusPrefix("src/foo.js"), "src/foo.js");
  assert.equal(stripGitStatusPrefix("a/b/c.ts"), "a/b/c.ts");
});

test("stripGitStatusPrefix strips porcelain v1 status prefixes", () => {
  assert.equal(stripGitStatusPrefix("M  src/foo.js"), "src/foo.js");
  assert.equal(stripGitStatusPrefix("A  new-file.ts"), "new-file.ts");
  assert.equal(stripGitStatusPrefix("D  deleted.ts"), "deleted.ts");
  assert.equal(stripGitStatusPrefix("R  old.ts -> new.ts"), "old.ts -> new.ts");
  assert.equal(stripGitStatusPrefix("?? added.ts"), "added.ts");
  assert.equal(stripGitStatusPrefix(" M modified.ts"), "modified.ts");
});

test("stripGitStatusPrefix returns empty string for falsy input", () => {
  assert.equal(stripGitStatusPrefix(""), "");
  assert.equal(stripGitStatusPrefix(null as unknown as string), "");
  assert.equal(stripGitStatusPrefix(undefined as unknown as string), "");
});

// ---------------------------------------------------------------------------
// normalizeRepoRelativePaths
// ---------------------------------------------------------------------------

test("normalizeRepoRelativePaths accepts valid repo-relative paths", () => {
  const result = normalizeRepoRelativePaths(["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result, ["src/a.ts", "src/b.ts"]);
});

test("normalizeRepoRelativePaths deduplicates and sorts", () => {
  const result = normalizeRepoRelativePaths(["b.ts", "a.ts", "b.ts"]);
  assert.deepEqual(result, ["a.ts", "b.ts"]);
});

test("normalizeRepoRelativePaths strips git status prefix before validation", () => {
  const result = normalizeRepoRelativePaths(["M  src/foo.js", "?? bar.js"]);
  assert.deepEqual(result, ["bar.js", "src/foo.js"]);
});

test("normalizeRepoRelativePaths rejects absolute paths", () => {
  assert.throws(
    () => normalizeRepoRelativePaths(["/etc/passwd"]),
    (error: unknown) => (error as Error).message.includes("invalid repo-relative path"),
  );
});

test("normalizeRepoRelativePaths rejects paths with backslash", () => {
  assert.throws(
    () => normalizeRepoRelativePaths(["src\\foo.js"]),
    (error: unknown) => (error as Error).message.includes("invalid repo-relative path"),
  );
});

test("normalizeRepoRelativePaths rejects paths with parent traversal", () => {
  assert.throws(
    () => normalizeRepoRelativePaths(["src/../etc/passwd"]),
    (error: unknown) => (error as Error).message.includes("invalid repo-relative path"),
  );
});

test("normalizeRepoRelativePaths accepts a single string value", () => {
  const result = normalizeRepoRelativePaths("src/foo.js");
  assert.deepEqual(result, ["src/foo.js"]);
});

// ---------------------------------------------------------------------------
// validateScopeConstraint
// ---------------------------------------------------------------------------

test("validateScopeConstraint returns withinScope=true when fixScope is empty", () => {
  const result = validateScopeConstraint({ diffPaths: ["src/a.ts"], fixScope: [] });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.violations, []);
});

test("validateScopeConstraint returns withinScope=true when diffPaths is empty", () => {
  const result = validateScopeConstraint({ diffPaths: [], fixScope: ["src/"] });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.violations, []);
});

test("validateScopeConstraint passes for exact match", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/foo.ts"],
    fixScope: ["src/foo.ts"],
  });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.violations, []);
});

test("validateScopeConstraint passes for directory prefix match with trailing slash", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/engine/runner.ts"],
    fixScope: ["src/engine/"],
  });
  assert.equal(result.withinScope, true);
});

test("validateScopeConstraint passes for directory prefix match without trailing slash", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/engine/runner.ts"],
    fixScope: ["src/engine"],
  });
  assert.equal(result.withinScope, true);
});

test("validateScopeConstraint fails for path outside scope", () => {
  const result = validateScopeConstraint({
    diffPaths: ["tests/unit/foo.test.ts"],
    fixScope: ["src/"],
  });
  assert.equal(result.withinScope, false);
  assert.deepEqual(result.violations, ["tests/unit/foo.test.ts"]);
});

test("validateScopeConstraint reports multiple violations", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/a.ts", "tests/b.ts", "docs/c.md"],
    fixScope: ["src/"],
  });
  assert.equal(result.withinScope, false);
  assert.deepEqual(result.violations, ["tests/b.ts", "docs/c.md"]);
});

test("validateScopeConstraint supports glob * pattern", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/foo.ts", "src/bar.ts"],
    fixScope: ["src/*.ts"],
  });
  assert.equal(result.withinScope, true);
});

test("validateScopeConstraint glob * does not match across directories", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/sub/foo.ts"],
    fixScope: ["src/*.ts"],
  });
  assert.equal(result.withinScope, false);
});

test("validateScopeConstraint supports glob ** pattern", () => {
  const result = validateScopeConstraint({
    diffPaths: ["src/deep/nested/foo.ts"],
    fixScope: ["src/**/*.ts"],
  });
  assert.equal(result.withinScope, true);
});

// ---------------------------------------------------------------------------
// evaluateScopeGuard
// ---------------------------------------------------------------------------

test("evaluateScopeGuard cleans git status prefixes from changedFiles", () => {
  const result = evaluateScopeGuard({
    changedFiles: ["M  src/foo.js", "?? bar.js"],
    fixScope: ["src/", "bar.js"],
  });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.changedFiles, ["src/foo.js", "bar.js"]);
});

test("evaluateScopeGuard handles non-array changedFiles gracefully", () => {
  const result = evaluateScopeGuard({
    changedFiles: null as unknown as unknown[],
    fixScope: ["src/"],
  });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.changedFiles, []);
});

test("evaluateScopeGuard handles non-array fixScope gracefully", () => {
  const result = evaluateScopeGuard({
    changedFiles: ["src/foo.ts"],
    fixScope: null as unknown as string[],
  });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.fixScope, []);
});

test("evaluateScopeGuard filters empty strings from inputs but keeps whitespace", () => {
  const result = evaluateScopeGuard({
    changedFiles: ["src/foo.ts", ""],
    fixScope: ["src/", ""],
  });
  assert.equal(result.withinScope, true);
  assert.deepEqual(result.changedFiles, ["src/foo.ts"]);
});
