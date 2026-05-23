import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

describe("static file path safety", () => {
  const webDist = path.resolve("/tmp/cpb-test/web/dist");

  function isPathSafe(requestPath) {
    const filePath = path.join(webDist, requestPath === "/" ? "index.html" : requestPath);
    const resolved = path.resolve(filePath);
    return resolved === webDist || resolved.startsWith(webDist + path.sep);
  }

  it("allows normal files", () => {
    assert.ok(isPathSafe("/app.js"));
    assert.ok(isPathSafe("/assets/logo.svg"));
    assert.ok(isPathSafe("/"));
  });

  it("blocks parent traversal", () => {
    assert.ok(!isPathSafe("/../../../etc/passwd"));
    assert.ok(!isPathSafe("/../../secret.txt"));
  });

  it("blocks adjacent prefix directory bypass", () => {
    assert.ok(!isPathSafe("/../dist-leak/secret.txt"));
    assert.ok(!isPathSafe("/../dist-backdoor/key.pem"));
  });

  it("blocks exact webDist directory without file", () => {
    // requesting the directory itself (no trailing slash, no index.html)
    const filePath = path.join(webDist, "/..");
    const resolved = path.resolve(filePath);
    // resolved would be /tmp/cpb-test/web which is NOT webDist
    assert.ok(!isPathSafe("/.."));
  });
});
