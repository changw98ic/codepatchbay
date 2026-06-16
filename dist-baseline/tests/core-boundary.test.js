import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT, scanBoundary, detectImportViolations, } from "./helpers/boundary-scanner.js";
const FORBIDDEN = new Set(["server", "runtime", "cli", "bridges"]);
test("core modules do not import infrastructure layers", async () => {
    const violations = await scanBoundary({
        scanDir: path.join(REPO_ROOT, "core"),
        forbiddenTargets: FORBIDDEN,
    });
    assert.deepEqual(violations, []);
});
test("scanner catches static import from core to server (negative)", () => {
    const source = `import { run } from "../../server/services/setup.js"`;
    const fakeFile = path.join(REPO_ROOT, "core/engine/test.js");
    const violations = detectImportViolations(source, fakeFile, FORBIDDEN);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].target, "server");
});
test("scanner catches dynamic import from core to runtime (negative)", () => {
    const source = `const mod = await import("../../runtime/acp-client-core.js")`;
    const fakeFile = path.join(REPO_ROOT, "core/engine/test.js");
    const violations = detectImportViolations(source, fakeFile, FORBIDDEN);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].target, "runtime");
});
test("scanner catches relative path crossing to bridges from core (negative)", () => {
    const source = `import { bridge } from "../../bridges/engine-bridge.js"`;
    const fakeFile = path.join(REPO_ROOT, "core/engine/test.js");
    const violations = detectImportViolations(source, fakeFile, FORBIDDEN);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].target, "bridges");
});
