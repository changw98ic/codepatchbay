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
  "bridges/run-pipeline.mjs",
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

const currentGuidanceGlobs = [
  "CLAUDE.md",
  "README*.md",
  "cli/**/*.{js,mjs}",
  "docs/**/*.md",
  "skills/**/*.md",
];

const historicalGuidanceMarkers = ["旧执行内核注释", "HISTORICAL:", "history-only"];

const deletedPathPatterns = [
  /bridges\/job-runner\.mjs/,
  /bridges\/run-phase\.mjs/,
  /bridges\/supervisor-loop\.mjs/,
  /server\/services\/supervisor\.js/,
  /server\/services\/phase-runner\.js/,
  /server\/services\/role-bridge\.js/,
];

const removedPhaseCommandPattern = /\bcpb\s+(plan|execute|verify)\b/;

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
      "run-pipeline.mjs",
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
      assert.equal(removedPhaseCommandPattern.test(content), false, `${file} still references removed phase commands`);
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

  it("does not route removed phase commands from the CLI command map", async () => {
    const router = await readFile(path.join(repoRoot, "cli/cpb.mjs"), "utf8");
    for (const command of ["plan", "execute", "verify", "supervisor"]) {
      assert.equal(
        new RegExp(`(?:^|[,\\s{])["']?${command}["']?\\s*:`, "m").test(router),
        false,
        `cli/cpb.mjs should not expose removed '${command}' command`,
      );
    }
  });

  it("does not publish current guidance for removed bridges or phase commands", async () => {
    const files = await glob(currentGuidanceGlobs, {
      cwd: repoRoot,
      ignore: ["node_modules/**", "server/node_modules/**", "web/node_modules/**", "docs/superpowers/plans/**"],
    });

    for (const file of files) {
      const content = await readFile(path.join(repoRoot, file), "utf8");
      if (historicalGuidanceMarkers.some((marker) => content.includes(marker))) continue;

      for (const pattern of deletedPathPatterns) {
        assert.equal(pattern.test(content), false, `${file} still publishes removed runtime path ${pattern}`);
      }
      assert.equal(removedPhaseCommandPattern.test(content), false, `${file} still publishes removed phase commands`);
    }
  });
});
