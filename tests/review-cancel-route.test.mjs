#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { reviewRoutes } from "../server/routes/review.js";
import { createSession, updateSession } from "../server/services/review-session.js";

async function buildApp(cpbRoot, opts = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.decorate("notifBroadcast", () => Promise.resolve());
  app.addHook("onRequest", (req, _res, done) => {
    if (opts.noCpbRoot) {
      // deliberately omit req.cpbRoot
    } else {
      req.cpbRoot = cpbRoot;
    }
    done();
  });
  await app.register(reviewRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("POST /api/review/:id/cancel", () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-test-cancel-"));
    await mkdir(path.join(tmpRoot, "cpb-task", "reviews"), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("cancels a session using req.cpbRoot (not req.flowRoot)", async () => {
    const session = await createSession(tmpRoot, {
      project: "test-proj",
      intent: "cancel test",
    });
    await updateSession(tmpRoot, session.sessionId, { status: "researching" });
    await updateSession(tmpRoot, session.sessionId, { status: "planning" });
    await updateSession(tmpRoot, session.sessionId, { status: "reviewing" });
    await updateSession(tmpRoot, session.sessionId, { status: "user_review" });

    const res = await app.inject({
      method: "POST",
      url: `/api/review/${session.sessionId}/cancel`,
      payload: { reason: "no longer needed" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.cancelled, true);
    assert.equal(body.sessionId, session.sessionId);
  });

  it("returns 404 for non-existent session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/review/rev-nonexistent/cancel",
      payload: {},
    });

    assert.equal(res.statusCode, 404);
  });

  it("returns 400 when req.cpbRoot is missing", async () => {
    const appNoRoot = await buildApp(tmpRoot, { noCpbRoot: true });
    try {
      const res = await appNoRoot.inject({
        method: "POST",
        url: "/api/review/rev-fake/cancel",
        payload: {},
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("missing project root"));
    } finally {
      await appNoRoot.close();
    }
  });
});
