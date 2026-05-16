#!/usr/bin/env node

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { migrateRuntimeRoot } from "../bridges/migrate-runtime-root.mjs";

async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), "cpb-migrate-runtime-"));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test("migrates CodePatchbay-owned legacy runtime data into cpb-task and removes migrated sources", async () => {
  const root = await makeRoot();
  try {
    await mkdir(path.join(root, ".omc/events/demo"), { recursive: true });
    await mkdir(path.join(root, ".omc/state"), { recursive: true });
    await mkdir(path.join(root, ".omc/worktrees/demo"), { recursive: true });
    await writeFile(path.join(root, ".omc/events/demo/job-1.jsonl"), "{\"type\":\"job_created\"}\n");
    await writeFile(path.join(root, ".omc/state/pipeline-demo.json"), "{\"status\":\"running\"}\n");
    await writeFile(path.join(root, ".omc/state/other-tool.json"), "{}\n");
    await writeFile(path.join(root, ".omc/worktrees/demo/README.md"), "worktree\n");

    const report = await migrateRuntimeRoot(root);

    assert.equal(
      await readFile(path.join(root, "cpb-task/events/demo/job-1.jsonl"), "utf8"),
      "{\"type\":\"job_created\"}\n"
    );
    assert.equal(
      await readFile(path.join(root, "cpb-task/state/pipeline-demo.json"), "utf8"),
      "{\"status\":\"running\"}\n"
    );
    assert.equal(
      await readFile(path.join(root, "cpb-task/worktrees/demo/README.md"), "utf8"),
      "worktree\n"
    );
    assert.equal(await exists(path.join(root, ".omc/events")), false);
    assert.equal(await exists(path.join(root, ".omc/state/pipeline-demo.json")), false);
    assert.equal(await exists(path.join(root, ".omc/worktrees")), false);
    assert.equal(await exists(path.join(root, ".omc/state/other-tool.json")), true);
    assert.ok(report.retained.some((entry) => entry.includes(".omc/state")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps legacy source when destination has a conflicting file", async () => {
  const root = await makeRoot();
  try {
    await mkdir(path.join(root, ".omc/events/demo"), { recursive: true });
    await mkdir(path.join(root, "cpb-task/events/demo"), { recursive: true });
    await writeFile(path.join(root, ".omc/events/demo/job-1.jsonl"), "legacy\n");
    await writeFile(path.join(root, "cpb-task/events/demo/job-1.jsonl"), "current\n");

    const report = await migrateRuntimeRoot(root);

    assert.equal(await readFile(path.join(root, ".omc/events/demo/job-1.jsonl"), "utf8"), "legacy\n");
    assert.equal(await readFile(path.join(root, "cpb-task/events/demo/job-1.jsonl"), "utf8"), "current\n");
    assert.ok(report.conflicts.some((entry) => entry.includes("job-1.jsonl")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains non-empty .omx because it is not a CodePatchbay runtime namespace", async () => {
  const root = await makeRoot();
  try {
    await mkdir(path.join(root, ".omx/state"), { recursive: true });
    await writeFile(path.join(root, ".omx/state/session.json"), "{}\n");

    const report = await migrateRuntimeRoot(root);

    assert.equal(await exists(path.join(root, ".omx/state/session.json")), true);
    assert.ok(report.retained.some((entry) => entry.includes(".omx")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("can quarantine remaining non-CodePatchbay .omc and .omx roots explicitly", async () => {
  const root = await makeRoot();
  try {
    await mkdir(path.join(root, ".omc/wiki"), { recursive: true });
    await mkdir(path.join(root, ".omx/state"), { recursive: true });
    await writeFile(path.join(root, ".omc/wiki/log.md"), "legacy\n");
    await writeFile(path.join(root, ".omx/state/session.json"), "{}\n");

    const report = await migrateRuntimeRoot(root, { quarantineNonFlow: true });

    assert.equal(await exists(path.join(root, ".omc")), false);
    assert.equal(await exists(path.join(root, ".omx")), false);
    assert.equal(report.quarantined.length, 2);
    assert.ok(report.quarantined.some((entry) => entry.includes("cpb-task/legacy-quarantine/omc-")));
    assert.ok(report.quarantined.some((entry) => entry.includes("cpb-task/legacy-quarantine/omx-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
