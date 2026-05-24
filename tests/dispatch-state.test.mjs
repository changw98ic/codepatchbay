import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runGateNode(source, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("dispatch-state", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-dispatch-test-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("createDispatch creates dispatch with status pending", async () => {
    const { createDispatch, getDispatch } = await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-1" });
    assert.ok(d.dispatchId.startsWith("dispatch-"));
    assert.equal(d.projectId, "proj-1");
    assert.equal(d.status, "pending");
    assert.ok(d.createdAt);

    const loaded = await getDispatch(tmpDir, d.dispatchId);
    assert.equal(loaded.status, "pending");
    assert.equal(loaded.dispatchId, d.dispatchId);
  });

  it("full lifecycle: pending -> assigned -> running -> completed", async () => {
    const { createDispatch, assignWorker, startDispatch, completeDispatch, getDispatch } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-lc" });

    const assigned = await assignWorker(tmpDir, d.dispatchId, { workerId: "w-1" });
    assert.equal(assigned.status, "assigned");
    assert.equal(assigned.workerId, "w-1");

    const started = await startDispatch(tmpDir, d.dispatchId);
    assert.equal(started.status, "running");

    const completed = await completeDispatch(tmpDir, d.dispatchId);
    assert.equal(completed.status, "completed");
  });

  it("full lifecycle: pending -> running -> failed (skip assigned)", async () => {
    const { createDispatch, startDispatch, failDispatch } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-fail" });
    const started = await startDispatch(tmpDir, d.dispatchId);
    assert.equal(started.status, "running");

    const failed = await failDispatch(tmpDir, d.dispatchId);
    assert.equal(failed.status, "failed");
  });

  it("rejects assignWorker on non-existent dispatch", async () => {
    const { assignWorker } = await import("../server/services/dispatch-state.js");
    await assert.rejects(
      () => assignWorker(tmpDir, "dispatch-nonexistent00000000-000000-abc", { workerId: "w-1" }),
      /non-existent dispatch/
    );
  });

  it("rejects startDispatch on non-existent dispatch", async () => {
    const { startDispatch } = await import("../server/services/dispatch-state.js");
    await assert.rejects(
      () => startDispatch(tmpDir, "dispatch-nonexistent00000000-000001-abc"),
      /non-existent dispatch/
    );
  });

  it("rejects mutation after terminal completed", async () => {
    const { createDispatch, startDispatch, completeDispatch, failDispatch, assignWorker } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-term" });
    await startDispatch(tmpDir, d.dispatchId);
    await completeDispatch(tmpDir, d.dispatchId);

    await assert.rejects(
      () => failDispatch(tmpDir, d.dispatchId),
      /terminal/
    );
    await assert.rejects(
      () => assignWorker(tmpDir, d.dispatchId, { workerId: "w-2" }),
      /terminal/
    );
    await assert.rejects(
      () => startDispatch(tmpDir, d.dispatchId),
      /terminal/
    );
  });

  it("rejects mutation after terminal failed", async () => {
    const { createDispatch, startDispatch, failDispatch, completeDispatch } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-term2" });
    await startDispatch(tmpDir, d.dispatchId);
    await failDispatch(tmpDir, d.dispatchId);

    await assert.rejects(
      () => completeDispatch(tmpDir, d.dispatchId),
      /terminal/
    );
  });

  it("rejects invalid transition: pending -> completed", async () => {
    const { createDispatch, completeDispatch } = await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-skip" });
    await assert.rejects(
      () => completeDispatch(tmpDir, d.dispatchId),
      /invalid transition/
    );
  });

  it("rejects invalid transition: assigned -> completed", async () => {
    const { createDispatch, assignWorker, completeDispatch } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-skip2" });
    await assignWorker(tmpDir, d.dispatchId, { workerId: "w-3" });

    await assert.rejects(
      () => completeDispatch(tmpDir, d.dispatchId),
      /invalid transition/
    );
  });

  it("rejects invalid transition: running -> assigned", async () => {
    const { createDispatch, startDispatch, assignWorker } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-back" });
    await startDispatch(tmpDir, d.dispatchId);

    await assert.rejects(
      () => assignWorker(tmpDir, d.dispatchId, { workerId: "w-4" }),
      /invalid transition/
    );
  });

  it("getDispatch returns null for missing dispatch", async () => {
    const { getDispatch } = await import("../server/services/dispatch-state.js");
    const result = await getDispatch(tmpDir, "dispatch-nonexistent00000000-000002-abc");
    assert.equal(result, null);
  });

  it("listDispatches filters by projectId and status", async () => {
    const { createDispatch, startDispatch, completeDispatch, listDispatches } =
      await import("../server/services/dispatch-state.js");

    const ts = new Date().toISOString();
    const d1 = await createDispatch(tmpDir, { projectId: "proj-list", ts });
    await startDispatch(tmpDir, d1.dispatchId);
    await completeDispatch(tmpDir, d1.dispatchId);

    const d2 = await createDispatch(tmpDir, { projectId: "proj-list", ts });

    const all = await listDispatches(tmpDir, { projectId: "proj-list" });
    assert.ok(all.length >= 2);

    const completed = await listDispatches(tmpDir, { projectId: "proj-list", status: "completed" });
    assert.ok(completed.length >= 1);
    assert.ok(completed.every((d) => d.status === "completed"));

    const pending = await listDispatches(tmpDir, { projectId: "proj-list", status: "pending" });
    assert.ok(pending.some((d) => d.dispatchId === d2.dispatchId));
  });

  it("listDispatches returns empty for missing directory", async () => {
    const { listDispatches } = await import("../server/services/dispatch-state.js");
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "cpb-no-dispatch-"));
    const result = await listDispatches(emptyDir);
    assert.deepEqual(result, []);
    await rm(emptyDir, { recursive: true });
  });

  it("createDispatch requires projectId", async () => {
    const { createDispatch } = await import("../server/services/dispatch-state.js");
    await assert.rejects(
      () => createDispatch(tmpDir, {}),
      /projectId is required/
    );
  });

  it("assignWorker requires workerId", async () => {
    const { createDispatch, assignWorker } = await import("../server/services/dispatch-state.js");
    const d = await createDispatch(tmpDir, { projectId: "proj-noworker" });
    await assert.rejects(
      () => assignWorker(tmpDir, d.dispatchId, {}),
      /workerId is required/
    );
  });

  it("materializeDispatch ignores events after any terminal status", async () => {
    const { materializeDispatch } = await import("../server/services/dispatch-state.js");

    const events = [
      { type: "dispatch_created", dispatchId: "dispatch-immutable", projectId: "p1", ts: "t1" },
      { type: "dispatch_started", dispatchId: "dispatch-immutable", ts: "t2" },
      { type: "dispatch_completed", dispatchId: "dispatch-immutable", ts: "t3" },
      { type: "dispatch_failed", dispatchId: "dispatch-immutable", ts: "t4" },
    ];

    const state = materializeDispatch(events);
    assert.equal(state.status, "completed");
    assert.equal(state.updatedAt, "t3");
  });

  it("concurrent terminal race: exactly one wins, final state is consistent", async () => {
    const { createDispatch, startDispatch, completeDispatch, failDispatch, getDispatch } =
      await import("../server/services/dispatch-state.js");

    const d = await createDispatch(tmpDir, { projectId: "proj-race" });
    await startDispatch(tmpDir, d.dispatchId);

    const results = await Promise.allSettled([
      completeDispatch(tmpDir, d.dispatchId),
      failDispatch(tmpDir, d.dispatchId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one terminal mutation should succeed");
    assert.equal(rejected.length, 1, "exactly one terminal mutation should reject");
    assert.ok(
      rejected[0].reason.message.includes("terminal"),
      `rejection should mention terminal, got: ${rejected[0].reason.message}`
    );

    const final = await getDispatch(tmpDir, d.dispatchId);
    assert.ok(
      final.status === "completed" || final.status === "failed",
      `final status should be a terminal state, got: ${final.status}`
    );
    assert.equal(
      fulfilled[0].value.status,
      final.status,
      "fulfilled result should match final persisted state"
    );
  });

  it("cross-process terminal race writes exactly one terminal event", async () => {
    const { createDispatch, startDispatch, getDispatch } =
      await import("../server/services/dispatch-state.js");

    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-dispatch-xproc-"));
    const gate = path.join(root, "go");
    const d = await createDispatch(root, { projectId: "proj-xproc" });
    await startDispatch(root, d.dispatchId);

    const source = `
      import { access } from "node:fs/promises";
      import { completeDispatch, failDispatch } from "./server/services/dispatch-state.js";
      const [root, dispatchId, action, gate] = process.argv.slice(1);
      for (;;) {
        try { await access(gate); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
      }
      try {
        if (action === "complete") await completeDispatch(root, dispatchId);
        else await failDispatch(root, dispatchId);
        process.stdout.write("ok");
      } catch (err) {
        process.stderr.write(err?.message || String(err));
        process.exitCode = 2;
      }
    `;

    try {
      const processes = Array.from({ length: 20 }, (_, i) =>
        runGateNode(source, [root, d.dispatchId, i % 2 === 0 ? "complete" : "fail", gate])
      );
      await writeFile(gate, "go", "utf8");
      const results = await Promise.all(processes);
      const succeeded = results.filter((result) => result.code === 0);
      assert.equal(succeeded.length, 1, "exactly one cross-process terminal mutation should succeed");

      const file = path.join(root, "dispatches", `${d.dispatchId}.jsonl`);
      const events = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      const terminalEvents = events.filter((event) =>
        event.type === "dispatch_completed" || event.type === "dispatch_failed"
      );
      assert.equal(terminalEvents.length, 1, "only one terminal event should be persisted");

      const final = await getDispatch(root, d.dispatchId);
      assert.equal(final.status, terminalEvents[0].type === "dispatch_completed" ? "completed" : "failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
