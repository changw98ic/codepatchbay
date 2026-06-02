import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";

import { getWorkflow, listWorkflows } from "../core/workflow/definition.js";
import { REQUIRED_EXECUTOR_FILES } from "../server/services/executor-root.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const removedLegacyFiles = [
  "bridges/job-runner.mjs",
  "bridges/run-phase.mjs",
  "bridges/supervisor-loop.mjs",
  "server/services/supervisor.js",
  "server/services/phase-runner.js",
  "server/services/role-bridge.js",
];

const runtimeGlobs = [
  "bridges/**/*.{js,mjs}",
  "cli/**/*.{js,mjs}",
  "core/**/*.js",
  "runtime/**/*.{js,mjs}",
  "server/**/*.{js,mjs}",
  "package.json",
];

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("legacy execution kernel removal", () => {
  it("does not ship legacy phase-runner files", async () => {
    for (const relativePath of removedLegacyFiles) {
      assert.equal(await exists(relativePath), false, `${relativePath} should be removed`);
    }
  });

  it("does not require removed legacy files from runtime source", async () => {
    const files = await glob(runtimeGlobs, {
      cwd: repoRoot,
      ignore: [
        "web/dist/**",
        "node_modules/**",
        "server/node_modules/**",
        "web/node_modules/**",
        ...removedLegacyFiles,
      ],
    });

    const banned = [
      "job-runner.mjs",
      "run-phase.mjs",
      "supervisor-loop.mjs",
      "server/services/supervisor.js",
      "services/supervisor.js",
      "phase-runner.js",
      "role-bridge.js",
      "cpb supervisor",
    ];

    for (const file of files) {
      const content = await readFile(path.join(repoRoot, file), "utf8");
      for (const marker of banned) {
        assert.equal(content.includes(marker), false, `${file} still references ${marker}`);
      }
    }
  });

  it("keeps executor root checks aligned with the native runJob engine", () => {
    assert.equal(REQUIRED_EXECUTOR_FILES.includes("bridges/engine-bridge.js"), true);
    assert.equal(REQUIRED_EXECUTOR_FILES.includes("runtime/worker/managed-worker.js"), true);
    assert.equal(REQUIRED_EXECUTOR_FILES.includes("bridges/job-runner.mjs"), false);
    assert.equal(REQUIRED_EXECUTOR_FILES.includes("bridges/run-phase.mjs"), false);
  });

  it("does not expose bridge scripts from workflow definitions", () => {
    for (const name of listWorkflows()) {
      const workflow = getWorkflow(name);
      assert.equal(Object.hasOwn(workflow, "bridgeForPhase"), false, `${name} should not expose bridgeForPhase`);
    }
  });
});
