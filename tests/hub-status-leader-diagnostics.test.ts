import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { _checkLeaderStateForTests } from "../cli/commands/doctor.js";
import { run as runHub } from "../cli/commands/hub.js";
import { LeaderLock } from "../server/orchestrator/leader-lock.js";
import { tempRoot, writeJson } from "./helpers.js";

type CapturedHubStatus = {
  code: unknown;
  output: Record<string, unknown>;
};

async function captureHubStatus(hubRoot: string): Promise<CapturedHubStatus> {
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  const output: string[] = [];
  const originalLog = console.log;
  process.env.CPB_HUB_ROOT = hubRoot;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  try {
    const code = await runHub(["status", "--json"], {
      cpbRoot: path.resolve(import.meta.dirname, "..", ".."),
      executorRoot: path.resolve(import.meta.dirname, "..", ".."),
    });
    return {
      code,
      output: JSON.parse(output.join("\n")) as Record<string, unknown>,
    };
  } finally {
    console.log = originalLog;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
}

async function writeLeader(hubRoot: string, value: Record<string, unknown>) {
  const leaderPath = path.join(hubRoot, "orchestrator", "leader.lock", "leader.json");
  await mkdir(path.dirname(leaderPath), { recursive: true });
  await writeJson(leaderPath, value);
  return leaderPath;
}

function blockedOrchestrator(output: Record<string, unknown>) {
  return output.orchestrator as {
    status: string;
    ready: boolean;
    blocked: boolean;
    reason: string;
    error: { code: string; message: string; leaderPath: string };
  };
}

test("hub status reports legacy leader state as blocked while preserving readable diagnostics", async () => {
  const hubRoot = await tempRoot("cpb-hub-status-legacy-leader");
  const legacy = {
    hubId: "legacy-hub",
    host: "legacy-host",
    pid: process.pid,
    epoch: 1,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const leaderPath = await writeLeader(hubRoot, legacy);

  const status = await captureHubStatus(hubRoot);
  const orchestrator = blockedOrchestrator(status.output);
  assert.equal(status.code, 1);
  assert.equal(status.output.ok, false);
  assert.equal(status.output.blocked, true);
  assert.equal(status.output.hubRoot, hubRoot);
  assert.equal(orchestrator.status, "blocked");
  assert.equal(orchestrator.ready, false);
  assert.equal(orchestrator.blocked, true);
  assert.equal(orchestrator.reason, "leader_state_invalid");
  assert.equal(orchestrator.error.code, "HUB_LEADER_STATE_INVALID");
  assert.equal(orchestrator.error.leaderPath, leaderPath);
  assert.equal(typeof (status.output.queue as { total?: unknown }).total, "number");
  assert.equal(typeof status.output.workers, "object");
  assert.deepEqual(JSON.parse(await readFile(leaderPath, "utf8")), legacy);

  const doctorResults: { errors: string[]; warnings: string[]; leaderState?: unknown } = {
    errors: [],
    warnings: [],
  };
  await _checkLeaderStateForTests(hubRoot, doctorResults);
  assert.match(doctorResults.errors[0], /HUB_LEADER_STATE_INVALID/);
  assert.equal((doctorResults.leaderState as { blocked?: unknown }).blocked, true);
});

test("invalid leader process identity remains blocked for status and mutation paths", async () => {
  const hubRoot = await tempRoot("cpb-hub-status-invalid-identity");
  const now = new Date().toISOString();
  const invalid = {
    hubId: "invalid-identity-hub",
    host: "invalid-host",
    pid: process.pid,
    processIdentity: {
      pid: process.pid + 1,
      birthId: "wrong-process",
      incarnation: `${process.pid + 1}:wrong-process`,
      capturedAt: now,
      birthIdPrecision: "exact",
    },
    epoch: 2,
    lockToken: "invalid-identity-token",
    initializing: false,
    startedAt: now,
    heartbeatAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const leaderPath = await writeLeader(hubRoot, invalid);

  const status = await captureHubStatus(hubRoot);
  assert.equal(status.code, 1);
  assert.equal(blockedOrchestrator(status.output).error.code, "HUB_LEADER_STATE_INVALID");

  const lock = new LeaderLock(hubRoot);
  await assert.rejects(lock.acquire(), { code: "HUB_LEADER_STATE_INVALID" });
  assert.deepEqual(JSON.parse(await readFile(leaderPath, "utf8")), invalid);
});

test("hub status keeps a valid leader state successful", async () => {
  const hubRoot = await tempRoot("cpb-hub-status-valid-leader");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();

  try {
    const status = await captureHubStatus(hubRoot);
    const orchestrator = status.output.orchestrator as {
      status?: unknown;
      blocked?: unknown;
      hubId?: unknown;
    };
    assert.equal(status.code, 0);
    assert.equal(status.output.ok, true);
    assert.equal(status.output.blocked, false);
    assert.equal(orchestrator.status, "running");
    assert.equal(orchestrator.blocked, false);
    assert.equal(orchestrator.hubId, lock.getHubId());
  } finally {
    await lock.release();
  }
});
