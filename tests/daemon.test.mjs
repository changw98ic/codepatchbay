import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("queue worker daemon service", () => {
  it("starts, reports, and stops a pool worker daemon with a pid file", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-daemon-"));
    const calls = [];
    try {
      const { startDaemon, statusDaemon, stopDaemon } = await import("../server/services/queue-daemon.js");
      const started = await startDaemon({
        cpbRoot,
        hubRoot: path.join(cpbRoot, "hub"),
        executorRoot: cpbRoot,
        spawnFn: (command, args, options) => {
          calls.push({ command, args, options });
          return {
            pid: 4242,
            unref() {},
            once() {},
          };
        },
      });

      assert.equal(started.status, "started");
      assert.equal(started.pid, 4242);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, process.execPath);
      assert.ok(calls[0].args.some((arg) => String(arg).endsWith("project-worker.mjs")));
      assert.ok(calls[0].args.includes("--pool"));

      const status = await statusDaemon({
        cpbRoot,
        isProcessAlive: (pid) => pid === 4242,
      });
      assert.equal(status.running, true);
      assert.equal(status.pid, 4242);

      const stopped = await stopDaemon({
        cpbRoot,
        killFn: (pid, signal) => {
          assert.equal(pid, 4242);
          assert.equal(signal, "SIGTERM");
        },
      });
      assert.equal(stopped.status, "stopped");
      assert.equal((await statusDaemon({ cpbRoot })).running, false);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});
