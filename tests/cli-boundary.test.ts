import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  scanTextFragments,
  detectTextFragments,
} from "./helpers/boundary-scanner.js";

const DELETED_CLI_BRIDGE_FRAGMENTS = [
  "bridges/cli",
  `"bridges", "cli"`,
  `'bridges', 'cli'`,
];

const FORBIDDEN_CLI_LAYER_FRAGMENTS = [
  "../../bridges/",
  "../bridges/",
  "bridges/",
  `"bridges"`,
  "'bridges'",
  "../../runtime/",
  "../runtime/",
  "runtime/",
  `"runtime"`,
  "'runtime'",
];

const ALLOWED_CLI_LAYER_VIOLATIONS = [
  "cli/commands/migrate-runtime-root.js:1: import { migrateRuntimeRoot, migrateToProjectRuntimeRoots, printReport } from \"../../runtime/migrate-runtime-root.js\";",
];

test("cli commands do not route through deleted bridge adapters", async () => {
  const violations = await scanTextFragments({
    scanDir: path.join(REPO_ROOT, "cli"),
    fragments: DELETED_CLI_BRIDGE_FRAGMENTS,
  });
  assert.deepEqual(violations, []);
});

test("cli commands do not call bridges or runtime directly", async () => {
  const violations = (await scanTextFragments({
    scanDir: path.join(REPO_ROOT, "cli"),
    fragments: FORBIDDEN_CLI_LAYER_FRAGMENTS,
  })).filter((hit: string) => !ALLOWED_CLI_LAYER_VIOLATIONS.includes(hit));
  assert.deepEqual(violations, []);
});

test("scanner catches static import from cli to deleted bridge adapters (negative)", () => {
  const source = `import { foo } from "../../bridges/cli/services/bar.js"`;
  const violations = detectTextFragments(source, DELETED_CLI_BRIDGE_FRAGMENTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0], "bridges/cli");
});

test("scanner catches dynamic import from cli to deleted bridge adapters (negative)", () => {
  const source = `const mod = await import("../../bridges/cli/services/hub-queue.js")`;
  const violations = detectTextFragments(source, DELETED_CLI_BRIDGE_FRAGMENTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0], "bridges/cli");
});

test("scanner catches path.join constructing deleted bridge adapter path (negative)", () => {
  const source = `const p = path.join(__dirname, "..", "bridges", "cli", "services", "foo.js")`;
  const violations = detectTextFragments(source, DELETED_CLI_BRIDGE_FRAGMENTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0], `"bridges", "cli"`);
});

test("scanner catches cli dynamic import to bridges layer (negative)", () => {
  const source = `const mod = await import("../../bridges/local-smoke.js")`;
  const violations = detectTextFragments(source, FORBIDDEN_CLI_LAYER_FRAGMENTS);
  assert.ok(violations.length >= 1);
  assert.ok(violations.includes("../../bridges/"));
});

test("scanner catches cli child process path to runtime layer (negative)", () => {
  const source = `const p = path.join(root, "runtime", "evolve", "multi-evolve.js")`;
  const violations = detectTextFragments(source, FORBIDDEN_CLI_LAYER_FRAGMENTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0], `"runtime"`);
});
