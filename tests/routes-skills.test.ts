import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { skillRoutes } from "../server/routes/skills.js";
import { loadRegistry, registerProject, saveRegistry } from "../server/services/hub/hub-registry.js";
import { completeJob, completePhase, createJob } from "../server/services/job/job-store.js";

async function buildApp(cpbRoot: string, hubRoot: string | null) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _res, done) => {
    const testReq = req as Record<string, any>;
    testReq.cpbRoot = cpbRoot;
    if (hubRoot) testReq.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(skillRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("POST /api/skills/extract", () => {
  let cpbRoot: string;
  let hubRoot: string;
  let projectRoot: string;
  let dataRoot: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-skills-route-"));
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-skills-hub-"));
    projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-skills-source-"));
    const project = await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath: projectRoot,
      skipCodeGraphGate: true,
    });
    dataRoot = project.projectRuntimeRoot;
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("looks up jobs through the registered project runtime root", async () => {
    const job = await createJob(cpbRoot, {
      project: "flow",
      task: "Extract reusable onboarding pattern",
      workflow: "standard",
      ts: "2026-06-11T02:00:00.000Z",
      dataRoot,
    });
    await completePhase(cpbRoot, "flow", job.jobId, {
      phase: "execute",
      artifact: "outputs/execute.md",
      ts: "2026-06-11T02:01:00.000Z",
      dataRoot,
    });
    await completePhase(cpbRoot, "flow", job.jobId, {
      phase: "verdict",
      artifact: "PASS",
      ts: "2026-06-11T02:02:00.000Z",
      dataRoot,
    });
    await completeJob(cpbRoot, "flow", job.jobId, {
      ts: "2026-06-11T02:03:00.000Z",
      dataRoot,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/extract",
      payload: { project: "flow", jobId: job.jobId },
    });

    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json(), {
      role: "executor",
      fileName: "extracted-extract-reusable-onboarding-pattern.md",
      status: "draft",
      isPositive: true,
      isAntiPattern: false,
    });

    const skill = await readFile(
      path.join(cpbRoot, "profiles/executor/skills/extracted-extract-reusable-onboarding-pattern.md"),
      "utf8"
    );
    assert.match(skill, /jobId: job-20260611-020000-/);
    assert.match(skill, /verdict: PASS/);
  });

  it("returns 404 when the project is not registered", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/extract",
      payload: { project: "missing", jobId: "job-20260611-020000-missing" },
    });

    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(res.json(), { error: "project not found: missing" });
  });

  it("returns 404 when the job is absent from the registered runtime root", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/extract",
      payload: { project: "flow", jobId: "job-20260611-020000-missing" },
    });

    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(res.json(), { error: "job not found" });
  });

  it("returns 400 when the registered project has no runtime root", async () => {
    const registry = await loadRegistry(hubRoot);
    delete registry.projects.flow.projectRuntimeRoot;
    await saveRegistry(hubRoot, registry);

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/extract",
      payload: { project: "flow", jobId: "job-20260611-020000-missing" },
    });

    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json(), { error: "project runtime root required: flow" });
  });

  it("returns 400 when the request has no hub root", async () => {
    const appWithoutHubRoot = await buildApp(cpbRoot, null);
    try {
      const res = await appWithoutHubRoot.inject({
        method: "POST",
        url: "/api/skills/extract",
        payload: { project: "flow", jobId: "job-20260611-020000-missing" },
      });

      assert.equal(res.statusCode, 400, res.body);
      assert.deepEqual(res.json(), { error: "hub root required" });
    } finally {
      await appWithoutHubRoot.close();
    }
  });
});
