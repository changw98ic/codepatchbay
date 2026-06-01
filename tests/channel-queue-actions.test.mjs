import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleChannelCommand } from "../server/services/channel-queue-actions.js";
import { enqueue, updateEntry } from "../server/services/hub-queue.js";

async function createQueueEntry(hubRoot, status) {
  const sourcePath = path.join(hubRoot, "source");
  await mkdir(sourcePath, { recursive: true });
  const entry = await enqueue(hubRoot, {
    projectId: "proj",
    sourcePath,
    type: "channel_command",
    description: "queued task",
    metadata: { source: "test" },
  });
  return updateEntry(hubRoot, entry.id, { status });
}

function approveParsed(job) {
  return {
    ok: true,
    actor: { userId: "reviewer" },
    command: { ok: true, type: "approve", job },
  };
}

describe("handleChannelCommand approval", () => {
  it("rejects approval unless the queue entry status is exactly waiting.approval", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-channel-action-"));
    const hubRoot = path.join(tmpRoot, "hub");
    const cpbRoot = path.join(tmpRoot, "cpb");

    try {
      const entry = await createQueueEntry(hubRoot, "blocked");
      const result = await handleChannelCommand(cpbRoot, approveParsed(entry.id), {
        hubRoot,
        channel: "slack",
      });

      assert.equal(result.ok, false);
      assert.match(result.error, /not waiting for approval/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
