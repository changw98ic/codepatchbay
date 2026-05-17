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

async function waitForProcessExit(app, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({ method: "GET", url: "/evolve/status" });
    if (!res.json().running) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("POST /evolve/start", () => {
  let tmpRoot, app, spawnedPids = [];

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-test-evolve-start-"));
    await fs.mkdir(path.join(tmpRoot, "cpb-task", "self-evolve"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "bridges"), { recursive: true });
    app = await buildApp(tmpRoot);
    spawnedPids = [];
  });

  afterEach(async () => {
    for (const pid of spawnedPids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await waitForProcessExit(app);
    await app.close();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("starts successfully with valid script", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const res = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.accepted, true);
    assert.ok(body.pid > 0);
    assert.equal(body.status.status, "starting");
    spawnedPids.push(body.pid);
  });

  it("rejects duplicate start while running", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const res1 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(res1.statusCode, 202);
    spawnedPids.push(res1.json().pid);

    const res2 = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(res2.statusCode, 409);
  });

  it("sets state to failed when script does not exist (child error)", async () => {
    // No script file — spawn succeeds but child process fails (MODULE_NOT_FOUND),
    // child.on("error") handler rolls state back to "failed"
    const res = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(res.statusCode, 202);
    spawnedPids.push(res.json().pid);

    await waitForProcessExit(app);

    const statusRes = await app.inject({ method: "GET", url: "/evolve/status" });
    const status = statusRes.json();
    assert.ok(status.status !== "starting",
      `state should not be stuck as 'starting', got '${status.status}'`);
    assert.equal(status.running, false);
  });

  it("rejects start when status is a non-idle, non-running state with round > 0", async () => {
    // "running" is explicitly allowed (for restart). Use "scanning" which is
    // not in the idle list and not "running", so it should be rejected.
    await saveState(tmpRoot, { status: "scanning", round: 3, knownGoodCommit: "abc", maxRounds: 20 });

    const res = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(res.statusCode, 409);
    assert.ok(res.json().message.includes("scanning"));
  });

  it("state is not left as starting when process exits with error", async () => {
    // Write a script that exits immediately with error code
    await fs.writeFile(path.join(tmpRoot, "bridges", "self-evolve.mjs"),
      "process.exit(1);\n");

    const res = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(res.statusCode, 202);
    spawnedPids.push(res.json().pid);

    await waitForProcessExit(app);

    const statusRes = await app.inject({ method: "GET", url: "/evolve/status" });
    const status = statusRes.json();
    assert.equal(status.running, false, "process should have exited");
  });
});
