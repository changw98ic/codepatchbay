import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

import { withDurableDirectoryLock } from "../core/runtime/durable-directory-lock.js";
import { appendEvent, eventFileFor } from "../server/services/event/event-store.js";
import { updateJobsIndexEntry } from "../server/services/job/job-store.js";
import { createSession, updateSession } from "../server/services/review/review-session.js";
import { tempRoot } from "./helpers.js";

function directoryFenceKey(lockDir: string) {
  return createHash("sha256")
    .update(`${path.resolve(lockDir)}\u0000durable-directory-lock-fence-v2`)
    .digest("hex");
}

function firstDirectoryFencePort(lockDir: string) {
  const digest = createHash("sha256").update(`${directoryFenceKey(lockDir)}\u0000${0}`).digest();
  return 20_000 + (digest.readUInt16BE(0) % 40_000);
}

async function withUnrelatedListenerOnFirstFencePort<T>(lockDir: string, fn: () => Promise<T>) {
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.end("unrelated-test-listener\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: firstDirectoryFencePort(lockDir), exclusive: true }, resolve);
  });
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("server locks skip an unrelated listener on the first process-fence candidate port", async () => {
  const root = await tempRoot("cpb-server-lock-process-fence");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const hubRoot = path.join(root, "hub");

  const project = "flow";
  const eventJobId = "job-20260721-010000-event-fence";
  const eventLock = `${eventFileFor(cpbRoot, project, eventJobId, { dataRoot })}.lock`;
  await withUnrelatedListenerOnFirstFencePort(eventLock, async () => {
    await appendEvent(cpbRoot, project, eventJobId, {
      type: "job_created",
      jobId: eventJobId,
      project,
      task: "event fence",
      workflow: "standard",
      ts: "2026-07-21T01:00:00.000Z",
    }, { dataRoot });
  });

  const jobsIndexLock = path.join(dataRoot, "jobs-index.json.lock");
  await withUnrelatedListenerOnFirstFencePort(jobsIndexLock, async () => {
    await updateJobsIndexEntry(cpbRoot, project, "job-20260721-010001-index-fence", {
      jobId: "job-20260721-010001-index-fence",
      project,
      status: "created",
      createdAt: "2026-07-21T01:00:01.000Z",
      updatedAt: "2026-07-21T01:00:01.000Z",
    }, { dataRoot });
  });

  const previousHubRoot = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    const session = await createSession(cpbRoot, { project, intent: "review fence" });
    const reviewLock = path.join(hubRoot, "reviews", ".locks", "reviews-operation.lock");
    await withUnrelatedListenerOnFirstFencePort(reviewLock, async () => {
      const updated = await updateSession(cpbRoot, session.sessionId, { status: "researching" });
      assert.equal(updated.status, "researching");
    });
  } finally {
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});

test("durable directory lock still treats the same keyed lock as mutually exclusive", async () => {
  const root = await tempRoot("cpb-directory-fence-mutual-exclusion");
  const lockDir = path.join(root, "same-key.lock");
  await withDurableDirectoryLock(lockDir, async () => {
    await assert.rejects(
      withDurableDirectoryLock(lockDir, async () => undefined, { waitMs: 500 }),
      (error: NodeJS.ErrnoException) => error.code === "DIRECTORY_LOCK_BUSY",
    );
  }, { waitMs: 1_000 });
});
