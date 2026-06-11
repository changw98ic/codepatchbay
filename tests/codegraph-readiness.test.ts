import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { checkCodeGraphReady } from "../server/services/infra.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { tempRoot } from "./helpers.js";

test("CodeGraph index-only flag is allowed through child env policy", () => {
  const env = buildChildEnv({
    CPB_CODEGRAPH_INDEX_ONLY_OK: "1",
    NOT_ALLOWED_FLAG: "1",
  }) as Record<string, any>;
  assert.equal(env.CPB_CODEGRAPH_INDEX_ONLY_OK, "1");
  assert.equal(env.NOT_ALLOWED_FLAG, undefined);
});

test("project runtime root is only passed to child env through explicit overrides", () => {
  const fromParent = buildChildEnv({
    CPB_PROJECT_RUNTIME_ROOT: "/tmp/poisoned-runtime-root",
  }) as Record<string, any>;
  assert.equal(fromParent.CPB_PROJECT_RUNTIME_ROOT, undefined);

  const explicit = buildChildEnv({}, {
    CPB_PROJECT_RUNTIME_ROOT: "/tmp/verified-runtime-root",
  }) as Record<string, any>;
  assert.equal(explicit.CPB_PROJECT_RUNTIME_ROOT, "/tmp/verified-runtime-root");
});

test("CodeGraph readiness can explicitly accept a static index without daemon state", async () => {
  const sourcePath = await tempRoot("cpb-codegraph-index-only");
  const cgDir = path.join(sourcePath, ".codegraph");
  await mkdir(cgDir, { recursive: true });
  await writeFile(path.join(cgDir, "codegraph.db"), Buffer.alloc(2048, 1));
  await writeFile(path.join(cgDir, "daemon.pid"), JSON.stringify({
    pid: process.pid,
    version: "test",
    codebaseRoot: sourcePath,
    socketPath: path.join(cgDir, "daemon.sock"),
  }) + "\n", "utf8");

  const readiness = await checkCodeGraphReady({ sourcePath });
  assert.equal(readiness.available, true);
  assert.match(readiness.indexFile, /codegraph\.db$/);
});

test("CodeGraph index-only mode ignores mismatched CPB root daemon state", async () => {
  const cpbRoot = await tempRoot("cpb-codegraph-index-only-cpb");
  const hubRoot = await tempRoot("cpb-codegraph-index-only-hub");
  const sourcePath = await tempRoot("cpb-codegraph-index-only-source");
  await mkdir(hubRoot, { recursive: true });
  await writeFile(path.join(hubRoot, "codegraph-state.json"), `${JSON.stringify({
    pid: process.pid,
    codebaseRoot: cpbRoot,
  }, null, 2)}\n`);
  const cgDir = path.join(sourcePath, ".codegraph");
  await mkdir(cgDir, { recursive: true });
  await writeFile(path.join(cgDir, "codegraph.db"), Buffer.alloc(2048, 1));
  await writeFile(path.join(cgDir, "daemon.pid"), JSON.stringify({
    pid: process.pid,
    version: "test",
    codebaseRoot: sourcePath,
    socketPath: path.join(cgDir, "daemon.sock"),
  }) + "\n", "utf8");

  const readiness = await checkCodeGraphReady({ cpbRoot, hubRoot, sourcePath });
  assert.equal(readiness.available, true);
});
