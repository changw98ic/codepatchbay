import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { enqueue, loadQueue } from "../server/services/hub-queue.js";

describe("hub-queue ACP lane metadata", () => {
  const tmpDirs = [];

  afterEach(async () => {
    while (tmpDirs.length) {
      await rm(tmpDirs.pop(), { recursive: true }).catch(() => {});
    }
  });

  async function freshHub() {
    const dir = await mkdtemp(path.join(tmpdir(), "cpb-acp-hq-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("normalizes missing metadata to headless defaults", async () => {
    const hubRoot = await freshHub();
    const entry = await enqueue(hubRoot, { projectId: "test-proj" });

    assert.equal(entry.metadata.acpProfile, "headless");
    assert.equal(entry.metadata.uiLane, false);
    assert.equal(entry.metadata.uiLaneReason, "");
  });

  it("preserves ui profile with reason", async () => {
    const hubRoot = await freshHub();
    const entry = await enqueue(hubRoot, {
      projectId: "test-proj",
      metadata: {
        acpProfile: "ui",
        uiLane: true,
        uiLaneReason: "end-to-end browser test",
      },
    });

    assert.equal(entry.metadata.acpProfile, "ui");
    assert.equal(entry.metadata.uiLane, true);
    assert.equal(entry.metadata.uiLaneReason, "end-to-end browser test");
  });

  it("throws for ui profile without reason", async () => {
    const hubRoot = await freshHub();
    await assert.rejects(
      () =>
        enqueue(hubRoot, {
          projectId: "test-proj",
          metadata: { acpProfile: "ui" },
        }),
      /uiLaneReason/,
    );
  });

  it("preserves headless profile with explicit metadata", async () => {
    const hubRoot = await freshHub();
    const entry = await enqueue(hubRoot, {
      projectId: "test-proj",
      metadata: { acpProfile: "headless" },
    });

    assert.equal(entry.metadata.acpProfile, "headless");
    assert.equal(entry.metadata.uiLane, false);
    assert.equal(entry.metadata.uiLaneReason, "");
  });

  it("persists ACP metadata through loadQueue", async () => {
    const hubRoot = await freshHub();
    await enqueue(hubRoot, {
      projectId: "persist-proj",
      metadata: {
        acpProfile: "ui",
        uiLane: true,
        uiLaneReason: "visual regression check",
      },
    });

    const queue = await loadQueue(hubRoot);
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].metadata.acpProfile, "ui");
    assert.equal(queue.entries[0].metadata.uiLane, true);
    assert.equal(queue.entries[0].metadata.uiLaneReason, "visual regression check");
  });
});
