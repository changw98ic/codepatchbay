import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildTaskLedger } from "../server/services/task-ledger.js";
import { enqueue } from "../server/services/hub-queue.js";

describe("task-ledger ACP lane metadata", () => {
  const tmpDirs = [];

  afterEach(async () => {
    while (tmpDirs.length) {
      await rm(tmpDirs.pop(), { recursive: true }).catch(() => {});
    }
  });

  async function freshRoot() {
    const dir = await mkdtemp(path.join(tmpdir(), "cpb-tl-acp-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("exposes headless ACP defaults for queue entry without metadata", async () => {
    const hubRoot = await freshRoot();
    const cpbRoot = await freshRoot();

    await enqueue(hubRoot, { projectId: "ledger-test", description: "ACP default check" });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });
    assert.equal(ledger.tasks.length, 1);

    const exec = ledger.tasks[0].agent.execution;
    assert.equal(exec.acpProfile, "headless");
    assert.equal(exec.uiLane, false);
    assert.equal(exec.uiLaneReason, "");
  });

  it("preserves ui ACP profile in agent.execution", async () => {
    const hubRoot = await freshRoot();
    const cpbRoot = await freshRoot();

    await enqueue(hubRoot, {
      projectId: "ledger-ui",
      description: "UI lane task",
      metadata: {
        acpProfile: "ui",
        uiLane: true,
        uiLaneReason: "screenshot diff verification",
      },
    });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });
    assert.equal(ledger.tasks.length, 1);

    const exec = ledger.tasks[0].agent.execution;
    assert.equal(exec.acpProfile, "ui");
    assert.equal(exec.uiLane, true);
    assert.equal(exec.uiLaneReason, "screenshot diff verification");
  });

  it("includes acpProfile, uiLane, uiLaneReason in queueTask output", async () => {
    const hubRoot = await freshRoot();
    const cpbRoot = await freshRoot();

    await enqueue(hubRoot, {
      projectId: "ledger-fields",
      description: "Field presence check",
    });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });
    const exec = ledger.tasks[0].agent.execution;

    assert.ok("acpProfile" in exec, "acpProfile field must exist");
    assert.ok("uiLane" in exec, "uiLane field must exist");
    assert.ok("uiLaneReason" in exec, "uiLaneReason field must exist");
  });
});
