import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { projectRoutes } from "../server/routes/projects.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { readJobsIndex, rebuildJobsIndex } from "../server/services/job/job-store.js";

async function buildApp(cpbRoot: string, hubRoot: string) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook("onRequest", (req, _res, done) => {
    const testReq = req as Record<string, any>;
    testReq.cpbRoot = cpbRoot;
    testReq.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(projectRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

async function appendCreatedJob(cpbRoot: string, project: string, jobId: string, dataRoot: string, second: number) {
  const suffix = String(second).padStart(2, "0");
  await appendEvent(
    cpbRoot,
    project,
    jobId,
    {
      type: "job_created",
      jobId,
      project,
      task: `project route job ${suffix}`,
      workflow: "standard",
      ts: `2026-06-11T02:00:${suffix}.000Z`,
    },
    { dataRoot }
  );
}

describe("GET /api/projects", () => {
  let cpbRoot: string;
  let hubRoot: string;
  let projectRoot: string;
  let dataRoot: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-projects-route-"));
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-projects-hub-"));
    projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-projects-source-"));
    dataRoot = path.join(hubRoot, "projects", "flow");
    await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath: projectRoot,
      skipCodeGraphGate: true,
    });
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("survives concurrent projection reads while jobs-index merges missing event streams", async () => {
    await appendCreatedJob(cpbRoot, "flow", "job-20260611-020000-seeded", dataRoot, 0);
    await rebuildJobsIndex(cpbRoot, { dataRoot });

    const expectedJobIds = new Set(["job-20260611-020000-seeded"]);
    let latestMissingJobId = "";
    for (let i = 1; i <= 20; i++) {
      latestMissingJobId = `job-20260611-0200${String(i).padStart(2, "0")}-missing`;
      expectedJobIds.add(latestMissingJobId);
      await appendCreatedJob(
        cpbRoot,
        "flow",
        latestMissingJobId,
        dataRoot,
        i
      );
    }

    const responses = await Promise.all(
      Array.from({ length: 30 }, () => app.inject({ method: "GET", url: "/api/projects" }))
    );

    assert.equal(responses.length, 30);
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].id, "flow");
      assert.equal(body[0].pipelineState?.status, "running");
      assert.equal(body[0].pipelineState?.jobId, latestMissingJobId);
    }

    const detailResponse = await app.inject({ method: "GET", url: "/api/projects/flow?fields=log" });
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detail = detailResponse.json();
    assert.equal(detail.pipelineState?.status, "running");
    assert.equal(detail.pipelineState?.jobId, latestMissingJobId);

    const index = await readJobsIndex(cpbRoot, { dataRoot });
    const expectedSorted = [...expectedJobIds].sort();
    assert.equal(index?._meta?.jobCount, expectedJobIds.size);
    assert.deepEqual(Object.keys(index?.jobs ?? {}).sort(), expectedSorted.map((jobId) => `flow/${jobId}`));
    assert.deepEqual(new Set(Object.values(index?.jobs ?? {}).map((job: any) => job.jobId)), expectedJobIds);
  });
});
