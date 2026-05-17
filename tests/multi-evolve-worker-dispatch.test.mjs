import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";

import { MultiEvolveController, CrossProjectPriorityQueue } from "../bridges/multi-evolve.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { listDispatches } from "../server/services/dispatch-state.js";
import { pushIssues, claimIssue } from "../server/services/multi-evolve-state.js";

describe("MultiEvolveController dispatch integration", () => {
  let cpbRoot;
  let hubRoot;
  let sourceDir;

  const originalEnabled = process.env.CPB_WORKER_DISPATCH_ENABLED;
  const originalHubRoot = process.env.CPB_HUB_ROOT;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-me-dispatch-cpb-"));
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-me-dispatch-hub-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "cpb-me-dispatch-src-"));
    process.env.CPB_WORKER_DISPATCH_ENABLED = "1";
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.CPB_WORKER_DISPATCH_ENABLED;
    else process.env.CPB_WORKER_DISPATCH_ENABLED = originalEnabled;
    if (originalHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = originalHubRoot;
  });

  test("executeIssue returns error when sourcePath guard fails", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "cpb-me-dispatch-other-"));
    await registerProject(hubRoot, { name: "guard-fail", sourcePath: sourceDir });

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    await controller.init({ project: "guard-fail" });

    const issue = {
      project: "guard-fail",
      sourcePath: otherDir,
      description: "test issue",
    };

    const result = await controller.executeIssue(issue);
    assert.equal(result.ok, false);
    assert.match(result.error, /sourcePath guard/);
  });

  test("executeIssue is unaffected when dispatch not enabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = undefined;

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    const result = await controller.executeIssue({
      project: "any",
      sourcePath: sourceDir,
      description: "test",
    });

    assert.equal(typeof result.ok, "boolean");
  });

  test("no dispatch records created when dispatch disabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = undefined;
    await registerProject(hubRoot, { name: "no-dispatch", sourcePath: sourceDir });

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    await controller.executeIssue({
      project: "no-dispatch",
      sourcePath: sourceDir,
      description: "test",
    });

    const dispatches = await listDispatches(hubRoot);
    assert.equal(dispatches.length, 0);
  });
});
