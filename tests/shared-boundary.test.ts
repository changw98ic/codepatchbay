import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  scanBoundary,
  detectImportViolations,
  detectDynamicPathViolations,
} from "./helpers/boundary-scanner.js";

const FORBIDDEN_SHARED_TARGETS = new Set(["core", "server", "runtime", "cli", "bridges"]);
const FORBIDDEN_SHARED_PATH_REFS = ["core", "server", "runtime", "cli", "bridges"];

test("shared modules do not import implementation layers", async () => {
  const violations = await scanBoundary({
    scanDir: path.join(REPO_ROOT, "shared"),
    forbiddenTargets: FORBIDDEN_SHARED_TARGETS,
  });
  assert.deepEqual(violations, []);
});

test("shared modules do not construct paths into implementation layers", async () => {
  const violations = await scanBoundary({
    scanDir: path.join(REPO_ROOT, "shared"),
    forbiddenTargets: new Set(),
    forbiddenDynamicRefs: FORBIDDEN_SHARED_PATH_REFS,
  });
  assert.deepEqual(violations, []);
});

test("scanner catches shared static import from server layer (negative)", () => {
  const source = `import { appendEvent } from "../server/services/event/event-store.js"`;
  const fakeFile = path.join(REPO_ROOT, "shared/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SHARED_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "server");
});

test("scanner catches shared type import from core layer (negative)", () => {
  const source = `import type { RunJobArtifactIndex } from "../core/engine/run-job-ports.js"`;
  const fakeFile = path.join(REPO_ROOT, "shared/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SHARED_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "core");
});

test("scanner catches shared dynamic import from bridge layer (negative)", () => {
  const source = `const mod = await import("../bridges/runtime-services.js")`;
  const fakeFile = path.join(REPO_ROOT, "shared/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SHARED_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "bridges");
});

test("scanner catches shared side-effect import from cli layer (negative)", () => {
  const source = `import "../cli/cpb.js"`;
  const fakeFile = path.join(REPO_ROOT, "shared/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SHARED_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "cli");
});

test("scanner catches shared export re-export from runtime layer (negative)", () => {
  const source = `export { run } from "../runtime/worker/managed-worker.js"`;
  const fakeFile = path.join(REPO_ROOT, "shared/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SHARED_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "runtime");
});

test("scanner catches shared require from server layer (negative)", () => {
  const source = `const server = require("../server/services/event/event-store.js")`;
  const fakeFile = path.join(REPO_ROOT, "shared/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SHARED_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "server");
});

test("scanner catches shared path construction into runtime layer (negative)", () => {
  const source = `const p = path.resolve(root, "runtime", "worker", "managed-worker.js")`;
  const violations = detectDynamicPathViolations(source, "runtime");
  assert.equal(violations.length, 1);
});

test("scanner catches shared string path construction into bridges layer (negative)", () => {
  const source = "const p = root + '/bridges/runtime-services.js'";
  const violations = detectDynamicPathViolations(source, "bridges");
  assert.equal(violations.length, 1);
});

test("scanner catches shared split string path construction into cli layer (negative)", () => {
  const source = `const p = "cli" + "/cpb.js"`;
  const violations = detectDynamicPathViolations(source, "cli");
  assert.equal(violations.length, 1);
});
