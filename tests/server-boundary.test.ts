import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  scanBoundary,
  detectImportViolations,
  detectDynamicPathViolations,
  scanTextFragments,
} from "./helpers/boundary-scanner.js";

const FORBIDDEN = new Set(["runtime"]);
const FORBIDDEN_SERVER_SERVICE_TARGETS = new Set(["bridges"]);

test("server modules do not import runtime implementations directly", async () => {
  const violations = await scanBoundary({
    scanDir: path.join(REPO_ROOT, "server"),
    forbiddenTargets: FORBIDDEN,
  });
  assert.deepEqual(violations, []);
});

test("server services do not import bridge adapters directly", async () => {
  const violations = await scanBoundary({
    scanDir: path.join(REPO_ROOT, "server", "services"),
    forbiddenTargets: FORBIDDEN_SERVER_SERVICE_TARGETS,
  });
  assert.deepEqual(violations, []);
});

test("server services do not call the runtime-facing engine bridge", async () => {
  const violations = (await scanTextFragments({
    scanDir: path.join(REPO_ROOT, "server", "services"),
    fragments: ["engine-bridge.js"],
  })).filter((hit: string) => !hit.startsWith("server/services/executor-root.js:"));
  assert.deepEqual(violations, []);
});

test("scanner catches dynamic import of old runtime path from server (negative)", () => {
  const source = `const guard = await import("../../runtime/delete-guard.js")`;
  const fakeFile = path.join(REPO_ROOT, "server/services/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "runtime");
});

test("scanner catches static import of runtime from server (negative)", () => {
  const source = `import { guard } from "../../runtime/delete-guard.js"`;
  const fakeFile = path.join(REPO_ROOT, "server/services/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "runtime");
});

test("scanner catches path.resolve constructing deleted runtime service path (negative)", () => {
  const source = `const p = path.resolve(__dirname, "..", "runtime", "acp-client-core.js")`;
  const violations = detectDynamicPathViolations(source, "runtime");
  assert.equal(violations.length, 1);
});

test("scanner catches server service import from bridges layer (negative)", () => {
  const source = `const bridge = await import("../../bridges/engine-bridge.js")`;
  const fakeFile = path.join(REPO_ROOT, "server/services/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_SERVER_SERVICE_TARGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "bridges");
});

test("scanner catches server service dynamic path to bridges layer (negative)", () => {
  const source = `const p = path.resolve(__dirname, "..", "..", "bridges", "engine-bridge.js")`;
  const violations = detectDynamicPathViolations(source, "bridges");
  assert.equal(violations.length, 1);
});
