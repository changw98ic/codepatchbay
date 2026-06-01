import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkerStore } from "../server/orchestrator/worker-store.js";

describe("WorkerStore idle detection", () => {
  it("does not reuse a ready worker while it still has inbox work", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-store-idle-"));

    try {
      const store = new WorkerStore(hubRoot);
      await store.init();
      await store.registerWorker("w-one", { status: "ready" });

      await store.writeInbox("w-one", {
        assignmentId: "a-one",
        entryId: "q-one",
        projectId: "alpha",
      });

      assert.equal(await store.findIdleWorker("alpha"), null);

      const inboxDir = path.join(hubRoot, "workers", "inbox", "w-one");
      const processingDir = path.join(inboxDir, "processing");
      await mkdir(processingDir, { recursive: true });
      await rename(path.join(inboxDir, "a-one.json"), path.join(processingDir, "a-one.json"));

      assert.equal(await store.findIdleWorker("alpha"), null);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });
});
