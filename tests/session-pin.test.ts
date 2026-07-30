import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinSessionToJob } from "../core/engine/session-pin.js";

test("pin writes sessionPin into the job process file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-pin-"));
  try {
    const dataRoot = path.join(dir, "data");
    const processesDir = path.join(dataRoot, "processes");
    await mkdir(processesDir, { recursive: true });
    const file = path.join(processesDir, "job-1.json");
    await writeFile(file, `${JSON.stringify({ jobId: "job-1", status: "running" }, null, 2)}\n`, "utf8");

    await pinSessionToJob(dir, "proj", "job-1", {
      phase: "verify", sessionId: "sess-9", agentPid: 4242, dataRoot,
    });

    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.status, "running");           // 原字段保留
    assert.equal(after.sessionPin.sessionId, "sess-9");
    assert.equal(after.sessionPin.agentPid, 4242);
    assert.equal(after.sessionPin.phase, "verify");
    assert.match(after.sessionPin.pinnedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pin is best-effort: missing process file → noop, no throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-pin-"));
  try {
    const dataRoot = path.join(dir, "data");
    await assert.doesNotReject(() =>
      pinSessionToJob(dir, "proj", "never-existed", {
        phase: "verify", sessionId: "s", agentPid: 1, dataRoot,
      }),
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});
