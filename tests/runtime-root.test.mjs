#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { runtimeDataPath, runtimeDataRoot } from "../server/services/runtime-root.js";

const root = path.resolve("/tmp/flow-root");

assert.equal(runtimeDataRoot(root), path.join(root, "flow-task"));
assert.equal(
  runtimeDataPath(root, "events", "demo"),
  path.join(root, "flow-task", "events", "demo")
);
assert.equal(
  runtimeDataPath(`${root}/`, "state", "pipeline-demo.json"),
  path.join(root, "flow-task", "state", "pipeline-demo.json")
);

