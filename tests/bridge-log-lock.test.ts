import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { appendPhaseLog } from "../bridges/run-phase.js";
import { withDurableDirectoryLock } from "../core/runtime/durable-directory-lock.js";
import { tempRoot } from "./helpers.js";

test("phase log append fails closed while the durable log lock is held", async () => {
  const root = await tempRoot("cpb-bridge-log-lock");
  const wikiDir = path.join(root, "wiki");
  const logFile = path.join(wikiDir, "log.md");
  const lockDir = path.join(wikiDir, ".cpb-log.lock");
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = withDurableDirectoryLock(lockDir, async () => {
    entered();
    await held;
  });
  await acquired;

  try {
    await assert.rejects(
      appendPhaseLog(root, "proj", "must not append unlocked", {
        dataRoot: root,
        wikiDir,
        inboxDir: path.join(wikiDir, "inbox"),
        outputsDir: path.join(wikiDir, "outputs"),
      }, { waitMs: 25 }),
      (error: NodeJS.ErrnoException) => error?.code === "DIRECTORY_LOCK_BUSY",
    );
    await assert.rejects(readFile(logFile, "utf8"), { code: "ENOENT" });
  } finally {
    release();
    await holder;
  }
});

test("phase log append is serialized by the durable lock and releases it", async () => {
  const root = await tempRoot("cpb-bridge-log-success");
  const wikiDir = path.join(root, "wiki");
  const runtime = {
    dataRoot: root,
    wikiDir,
    inboxDir: path.join(wikiDir, "inbox"),
    outputsDir: path.join(wikiDir, "outputs"),
  };

  await Promise.all([
    appendPhaseLog(root, "proj", "first", runtime),
    appendPhaseLog(root, "proj", "second", runtime),
  ]);

  const content = await readFile(path.join(wikiDir, "log.md"), "utf8");
  assert.match(content, /\| first\n/);
  assert.match(content, /\| second\n/);
});

test("phase log append refuses a symbolic-link target", async () => {
  const root = await tempRoot("cpb-bridge-log-symlink");
  const wikiDir = path.join(root, "wiki");
  const outside = path.join(root, "outside.md");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, path.join(wikiDir, "log.md"));

  await assert.rejects(
    appendPhaseLog(root, "proj", "must not escape", {
      dataRoot: root,
      wikiDir,
      inboxDir: path.join(wikiDir, "inbox"),
      outputsDir: path.join(wikiDir, "outputs"),
    }),
    (error: NodeJS.ErrnoException) => error.code === "PHASE_LOG_UNSAFE"
      || error.code === "PHASE_LOG_APPEND_COMMITTED_AMBIGUOUS",
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("phase log append refuses a hard-linked target without mutating the outside file", async () => {
  const root = await tempRoot("cpb-bridge-log-hardlink");
  const wikiDir = path.join(root, "wiki");
  const outside = path.join(root, "outside.md");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(outside, "outside\n", "utf8");
  await link(outside, path.join(wikiDir, "log.md"));

  await assert.rejects(
    appendPhaseLog(root, "proj", "must not escape", {
      dataRoot: root,
      wikiDir,
      inboxDir: path.join(wikiDir, "inbox"),
      outputsDir: path.join(wikiDir, "outputs"),
    }),
    (error: NodeJS.ErrnoException) => error.code === "PHASE_LOG_UNSAFE",
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});
