import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveRuntimeBin } from "../server/services/runtime-cli.js";

test("runtime binary default resolves from CPB install root, not Hub root", () => {
  const previousBin = process.env.CPB_RUNTIME_BIN;
  const previousInstallRoot = process.env.CPB_INSTALL_ROOT;
  delete process.env.CPB_RUNTIME_BIN;
  process.env.CPB_INSTALL_ROOT = "/opt/cpb-install";

  try {
    assert.equal(
      resolveRuntimeBin("/tmp/global-hub"),
      path.resolve("/opt/cpb-install/runtime/target/debug/cpb-runtime"),
    );
  } finally {
    if (previousBin === undefined) delete process.env.CPB_RUNTIME_BIN;
    else process.env.CPB_RUNTIME_BIN = previousBin;
    if (previousInstallRoot === undefined) delete process.env.CPB_INSTALL_ROOT;
    else process.env.CPB_INSTALL_ROOT = previousInstallRoot;
  }
});
