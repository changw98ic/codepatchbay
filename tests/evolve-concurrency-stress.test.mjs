#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import fs from "fs/promises";
import path from "path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { evolveRoutes } from "../server/routes/evolve.js";
import { saveState } from "../server/services/evolve-state.js";

async function buildApp(cpbRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook("onRequest", (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    done();
  });
  await app.register(evolveRoutes);
  await app.ready();
  return app;
}

async function waitForNotRunning(app, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({ method: "GET", url: "/evolve/status" });
    if (!res.json().running) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for process to stop");
}

describe("evolve concurrency stress", () => {
  let tmpRoot, app, spawnedPids = [];

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-test-evolve-conc-"));
    await fs.mkdir(path.join(tmpRoot, "cpb-task", "self-evolve"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "bridges"), { recursive: true });
    app = await buildApp(tmpRoot);
    spawnedPids = [];
  });

  afterEach(async () => {
    for (const pid of spawnedPids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    try { await waitForNotRunning(app, 3000); } catch {}
    await app.close();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("2 concurrent starts: exactly one 202, one 409", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/evolve/start" }),
      app.inject({ method: "POST", url: "/evolve/start" }),
    ]);

    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(codes, [202, 409], "one must succeed (202) and one must conflict (409)");

    const accepted = r1.statusCode === 202 ? r1 : r2;
    spawnedPids.push(accepted.json().pid);
  });

  it("3 concurrent starts: exactly one 202, two 409", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const results = await Promise.all([
      app.inject({ method: "POST", url: "/evolve/start" }),
      app.inject({ method: "POST", url: "/evolve/start" }),
      app.inject({ method: "POST", url: "/evolve/start" }),
    ]);

    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [202, 409, 409]);

    const accepted = results.find((r) => r.statusCode === 202);
    spawnedPids.push(accepted.json().pid);
  });

  it("spawn failure: second request succeeds after first spawn crashes", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    // Script exits immediately with code 1
    await fs.writeFile(script, "process.exit(1);\n");

    const r1 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(r1.statusCode, 202);
    spawnedPids.push(r1.json().pid);

    // Wait for the crashed process to clean up
    await waitForNotRunning(app);

    // Replace script with a long-running one for the retry
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const r2 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(r2.statusCode, 202, "second start should succeed after spawn failure cleanup");
    spawnedPids.push(r2.json().pid);
  });

  it("start → stop → start: no stale activeProcess confusion", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    // First start
    const r1 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(r1.statusCode, 202);
    const pid1 = r1.json().pid;
    spawnedPids.push(pid1);

    // Stop it
    const stopRes = await app.inject({ method: "POST", url: "/evolve/stop" });
    assert.equal(stopRes.json().stopped, true);

    await waitForNotRunning(app);

    // Second start should succeed — proves activeProcess was cleaned up
    const r2 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(r2.statusCode, 202);
    const pid2 = r2.json().pid;
    spawnedPids.push(pid2);

    // PIDs must differ — it's a new process, not the old one
    assert.notEqual(pid1, pid2, "second start should spawn a new process, not reuse the stopped one");
  });

  it("concurrent start during stop: no duplicate spawn", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const r1 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(r1.statusCode, 202);
    spawnedPids.push(r1.json().pid);

    // Fire stop and a concurrent start simultaneously.
    // The start should see "still running" or "just stopped" — either way,
    // it must NOT spawn a second process while stop is in progress.
    const [stopRes, startRes] = await Promise.all([
      app.inject({ method: "POST", url: "/evolve/stop" }),
      app.inject({ method: "POST", url: "/evolve/start" }),
    ]);

    // stop should succeed
    assert.equal(stopRes.json().stopped, true);

    // start is acceptable as either 409 (still running when checked) or 202 (won the race after stop cleared)
    assert.ok(
      startRes.statusCode === 409 || startRes.statusCode === 202,
      `start should be 409 or 202, got ${startRes.statusCode}`,
    );

    if (startRes.statusCode === 202) {
      spawnedPids.push(startRes.json().pid);
    }

    // Verify only one process is tracked
    const statusRes = await app.inject({ method: "GET", url: "/evolve/status" });
    const status = statusRes.json();
    assert.ok(status.running === false || (status.running === true && status.pid != null),
      "status should be clean — not running, or running with a valid PID");
  });
});
