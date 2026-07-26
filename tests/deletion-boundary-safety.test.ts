import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  completeDispatch,
  createDispatch,
  deleteDispatchFile,
  startDispatch,
  withDispatchLockTestHooksForTests,
} from "../server/services/dispatch/dispatch.js";
import {
  deleteCheckpoint,
  withEventLockTestHooksForTests,
  writeCheckpoint,
} from "../server/services/event/event-store.js";
import { tempRoot } from "./helpers.js";

test("dispatch deletion rejects non-terminal durable history", async () => {
  const hubRoot = await tempRoot("cpb-dispatch-delete-active");
  const created = await createDispatch(hubRoot, {
    projectId: "flow",
    sourcePath: hubRoot,
    ts: "2026-07-22T00:00:00.000Z",
  });
  const dispatchId = String(created?.dispatchId);
  const filePath = path.join(hubRoot, "dispatches", `${dispatchId}.jsonl`);
  const before = await readFile(filePath, "utf8");

  await assert.rejects(deleteDispatchFile(hubRoot, dispatchId), {
    code: "DISPATCH_DELETE_NON_TERMINAL",
  });
  assert.equal(await readFile(filePath, "utf8"), before);
});

test("dispatch deletion rejects a symlink without reading or removing its target", async () => {
  const root = await tempRoot("cpb-dispatch-delete-symlink");
  const hubRoot = path.join(root, "hub");
  const dispatchId = "dispatch-20260722-000004-hostile";
  const filePath = path.join(hubRoot, "dispatches", `${dispatchId}.jsonl`);
  const outside = path.join(root, "outside-dispatch.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(outside, "outside-dispatch\n", "utf8");
  await symlink(outside, filePath);

  await assert.rejects(deleteDispatchFile(hubRoot, dispatchId), {
    code: "BOUNDED_FILE_UNSAFE",
  });
  assert.equal(await readFile(outside, "utf8"), "outside-dispatch\n");
});

test("terminal dispatch deletion isolates the authorized generation with recovery evidence", async () => {
  const hubRoot = await tempRoot("cpb-dispatch-delete-terminal");
  const created = await createDispatch(hubRoot, {
    projectId: "flow",
    sourcePath: hubRoot,
    ts: "2026-07-22T00:00:08.000Z",
  });
  const dispatchId = String(created?.dispatchId);
  await startDispatch(hubRoot, dispatchId, { ts: "2026-07-22T00:00:09.000Z" });
  await completeDispatch(hubRoot, dispatchId, { ts: "2026-07-22T00:00:10.000Z" });
  const filePath = path.join(hubRoot, "dispatches", `${dispatchId}.jsonl`);

  const evidence = await deleteDispatchFile(hubRoot, dispatchId) as { quarantinePath: string } | undefined;
  assert.ok(evidence?.quarantinePath);
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
  assert.match(await readFile(evidence.quarantinePath, "utf8"), /dispatch_completed/);
});

test("dispatch deletion preserves a same-path successor installed at the final boundary", async () => {
  const hubRoot = await tempRoot("cpb-dispatch-delete-successor");
  const created = await createDispatch(hubRoot, {
    projectId: "flow",
    sourcePath: hubRoot,
    ts: "2026-07-22T00:00:01.000Z",
  });
  const dispatchId = String(created?.dispatchId);
  await startDispatch(hubRoot, dispatchId, { ts: "2026-07-22T00:00:02.000Z" });
  await completeDispatch(hubRoot, dispatchId, { ts: "2026-07-22T00:00:03.000Z" });
  const filePath = path.join(hubRoot, "dispatches", `${dispatchId}.jsonl`);
  const predecessorPath = `${filePath}.predecessor`;
  const successor = `${JSON.stringify({ sentinel: "dispatch-successor" })}\n`;

  await assert.rejects(
    withDispatchLockTestHooksForTests({
      async beforeDeleteFinalRename({ filePath: target }) {
        await rename(target, predecessorPath);
        await writeFile(target, successor, "utf8");
      },
    }, () => deleteDispatchFile(hubRoot, dispatchId)),
    { code: "DURABLE_REMOVE_RACE" },
  );

  assert.equal(await readFile(filePath, "utf8"), successor);
  assert.match(await readFile(predecessorPath, "utf8"), /dispatch_completed/);
});

test("dispatch deletion binds terminal authorization to the exact validated snapshot", async () => {
  const hubRoot = await tempRoot("cpb-dispatch-delete-snapshot-successor");
  const created = await createDispatch(hubRoot, {
    projectId: "flow",
    sourcePath: hubRoot,
    ts: "2026-07-22T00:00:05.000Z",
  });
  const dispatchId = String(created?.dispatchId);
  await startDispatch(hubRoot, dispatchId, { ts: "2026-07-22T00:00:06.000Z" });
  await completeDispatch(hubRoot, dispatchId, { ts: "2026-07-22T00:00:07.000Z" });
  const filePath = path.join(hubRoot, "dispatches", `${dispatchId}.jsonl`);
  const predecessorPath = `${filePath}.authorized-predecessor`;
  const successor = `${JSON.stringify({ sentinel: "post-authorization-successor" })}\n`;

  await assert.rejects(
    withDispatchLockTestHooksForTests({
      async afterDeleteSnapshot({ filePath: target }) {
        await rename(target, predecessorPath);
        await writeFile(target, successor, "utf8");
      },
    }, () => deleteDispatchFile(hubRoot, dispatchId)),
    { code: "DISPATCH_DELETE_SNAPSHOT_CHANGED" },
  );

  assert.equal(await readFile(filePath, "utf8"), successor);
  assert.match(await readFile(predecessorPath, "utf8"), /dispatch_completed/);
});

test("checkpoint deletion refuses symlinks and preserves their targets", async () => {
  const root = await tempRoot("cpb-checkpoint-delete-symlink");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const filePath = path.join(dataRoot, "checkpoints", "flow", "job-symlink.json");
  const outside = path.join(root, "outside-checkpoint.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(outside, "outside-checkpoint\n", "utf8");
  await symlink(outside, filePath);

  await assert.rejects(
    deleteCheckpoint(cpbRoot, "flow", "job-symlink", { dataRoot }),
    { code: "DURABLE_REMOVE_UNSAFE" },
  );
  assert.equal(await readFile(outside, "utf8"), "outside-checkpoint\n");
});

test("checkpoint deletion preserves a same-path successor installed at the final boundary", async () => {
  const root = await tempRoot("cpb-checkpoint-delete-successor");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const filePath = await writeCheckpoint(
    cpbRoot,
    "flow",
    "job-successor",
    { jobId: "job-successor", project: "flow", status: "completed" },
    { dataRoot },
  );
  const predecessorPath = `${filePath}.predecessor`;
  const successor = `${JSON.stringify({ sentinel: "checkpoint-successor" })}\n`;

  await assert.rejects(
    withEventLockTestHooksForTests({
      async beforeCheckpointDeleteFinalRename({ filePath: target }) {
        await rename(target, predecessorPath);
        await writeFile(target, successor, "utf8");
      },
    }, () => deleteCheckpoint(cpbRoot, "flow", "job-successor", { dataRoot })),
    { code: "DURABLE_REMOVE_RACE" },
  );

  assert.equal(await readFile(filePath, "utf8"), successor);
  assert.match(await readFile(predecessorPath, "utf8"), /job-successor/);
});

test("checkpoint deletion isolates the exact cache generation with recovery evidence", async () => {
  const root = await tempRoot("cpb-checkpoint-delete-owned");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const filePath = await writeCheckpoint(
    cpbRoot,
    "flow",
    "job-owned",
    { jobId: "job-owned", project: "flow", status: "completed" },
    { dataRoot },
  );

  const evidence = await deleteCheckpoint(cpbRoot, "flow", "job-owned", { dataRoot });
  assert.ok(evidence?.quarantinePath);
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
  assert.match(await readFile(evidence.quarantinePath, "utf8"), /job-owned/);
});
