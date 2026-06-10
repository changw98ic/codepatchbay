import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { checkCodeGraphReady } from "../server/services/codegraph-readiness.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { tempRoot } from "./helpers.mjs";

test("CodeGraph index-only flag is allowed through child env policy", () => {
  const env = buildChildEnv({
    CPB_CODEGRAPH_INDEX_ONLY_OK: "1",
    NOT_ALLOWED_FLAG: "1",
  });
  assert.equal(env.CPB_CODEGRAPH_INDEX_ONLY_OK, "1");
  assert.equal(env.NOT_ALLOWED_FLAG, undefined);
});

test("CodeGraph readiness can explicitly accept a static index without daemon state", async () => {
  const sourcePath = await tempRoot("cpb-codegraph-index-only");
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), Buffer.alloc(2048, 1));

  const previous = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  try {
    const readiness = await checkCodeGraphReady({ sourcePath });
    assert.equal(readiness.available, true);
    assert.equal(readiness.indexOnly, true);
    assert.equal(readiness.state, null);
    assert.match(readiness.indexFile, /codegraph\.db$/);
  } finally {
    if (previous === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previous;
  }
});

test("CodeGraph index-only mode ignores mismatched CPB root daemon state", async () => {
  const cpbRoot = await tempRoot("cpb-codegraph-index-only-cpb");
  const sourcePath = await tempRoot("cpb-codegraph-index-only-source");
  await mkdir(path.join(cpbRoot, "cpb-task"), { recursive: true });
  await writeFile(path.join(cpbRoot, "cpb-task", "codegraph-state.json"), `${JSON.stringify({
    pid: process.pid,
    codebaseRoot: cpbRoot,
  }, null, 2)}\n`);
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), Buffer.alloc(2048, 1));

  const previous = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  try {
    const readiness = await checkCodeGraphReady({ cpbRoot, sourcePath });
    assert.equal(readiness.available, true);
    assert.equal(readiness.indexOnly, true);
    assert.equal(readiness.state, null);
  } finally {
    if (previous === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previous;
  }
});
