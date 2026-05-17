#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import fs from "fs/promises";
import path from "path";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { evolveRoutes } from "../server/routes/evolve.js";

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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeLease(cpbRoot, pid) {
  const leaseDir = path.join(cpbRoot, "cpb-task", "self-evolve", ".controller-lock");
  await fs.mkdir(leaseDir, { recursive: true });
  await fs.writeFile(
    path.join(leaseDir, "meta.json"),
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
  );
}

describe("POST /evolve/stop - PID ownership verification", () => {
  let tmpRoot, app, children = [];

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-test-stop-safety-"));
    await fs.mkdir(path.join(tmpRoot, "cpb-task", "self-evolve"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "bridges"), { recursive: true });
    app = await buildApp(tmpRoot);
    children = [];
  });

  afterEach(async () => {
    for (const c of children) {
      try { c.kill("SIGKILL"); } catch {}
    }
    await app.close();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("returns not_running when no lease exists", async () => {
    const res = await app.inject({ method: "POST", url: "/evolve/stop" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { stopped: false, reason: "not_running" });
  });

  it("returns not_running when lease PID is dead (stale lease)", async () => {
    await writeLease(tmpRoot, 99999999);
    const res = await app.inject({ method: "POST", url: "/evolve/stop" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().stopped, false);
  });

  it("refuses SIGTERM when lease PID is alive but not self-evolve", async () => {
    await writeLease(tmpRoot, process.pid);

    const res = await app.inject({ method: "POST", url: "/evolve/stop" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.stopped, true);
    assert.equal(body.sigtermSent, false);
    assert.equal(body.source, "lease");
  });

  it("sends SIGTERM when lease PID is a verified self-evolve process", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const child = spawn("node", [script], { stdio: "ignore" });
    children.push(child);

    await new Promise((r) => setTimeout(r, 150));
    assert.ok(pidAlive(child.pid), "child should be alive before stop");

    await writeLease(tmpRoot, child.pid);

    const res = await app.inject({ method: "POST", url: "/evolve/stop" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.stopped, true);
    assert.equal(body.sigtermSent, true);

    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!pidAlive(child.pid), "child should be terminated after stop");
  });

  it("stops active process started via API", async () => {
    const script = path.join(tmpRoot, "bridges", "self-evolve.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60000);\n");

    const startRes = await app.inject({ method: "POST", url: "/evolve/start" });
    assert.equal(startRes.statusCode, 202);
    const startedPid = startRes.json().pid;
    children.push({ pid: startedPid, kill(sig) { try { process.kill(startedPid, sig); } catch {} } });

    await new Promise((r) => setTimeout(r, 100));

    const stopRes = await app.inject({ method: "POST", url: "/evolve/stop" });
    assert.equal(stopRes.statusCode, 200);
    const body = stopRes.json();
    assert.equal(body.stopped, true);
    assert.equal(body.sigtermSent, true);
    assert.equal(body.source, "ui-process");
  });
});
