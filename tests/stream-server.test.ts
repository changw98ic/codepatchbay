import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendEvent } from "../server/services/event/event-store.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { completeJob, createJob } from "../server/services/job/job-store.js";
import { startStreamServer } from "../server/services/stream/stream-server.js";

test("stream job panel exposes completion report and runtime policy without breaking JSON detail", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-stream-panel-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-stream-panel-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-stream-panel-src-"));
  const project = "flow";
  const jobId = "job-20260706-panel";
  let stream: Awaited<ReturnType<typeof startStreamServer>> | null = null;

  try {
    const registeredProject = await registerProject(hubRoot, {
      id: project,
      name: project,
      sourcePath,
      skipCodeGraphGate: true,
    });
    const dataRoot = registeredProject.projectRuntimeRoot;
    const job = await createJob(cpbRoot, {
      project,
      task: "render stream job visibility panel",
      jobId,
      ts: "2026-07-06T02:00:00.000Z",
      dataRoot,
    });

    const phaseBudgetPolicy = {
      riskLevel: "high",
      verificationDepth: "strict",
      adversarialRequired: true,
      evidenceRequirements: ["canonical_command", "real_path_trace", "adversarial_verdict"],
      phases: {
        execute: { toolCallBudget: 100, toolEventBudget: 400, idleTimeoutMs: 150000, noEditToolLimit: 8 },
        verify: { toolCallBudget: 80, toolEventBudget: 320, idleTimeoutMs: 150000 },
      },
      reasons: ["riskLevel=high", "riskSignal=high_product_surface"],
    };
    const completionReport = {
      schemaVersion: 1,
      changedFiles: ["server/services/stream/stream-server.ts"],
      changedFileCount: 1,
      realActors: ["stream viewer"],
      realEntrypoints: ["GET /jobs/:project/:jobId/panel"],
      bypassCandidates: ["raw JSON only"],
      evidenceClasses: ["canonical_command"],
      evidenceOrigins: ["agent_regression_test"],
      commands: ["node --test dist/tests/stream-server.test.js"],
      evidenceCounts: { passed: 1, failed: 0, total: 1 },
      residualRisk: { riskLevel: "high", adversarialRequired: true, notes: ["React workspace unavailable"] },
    };

    await appendEvent(cpbRoot, project, job.jobId, {
      type: "riskmap_generated",
      jobId: job.jobId,
      project,
      phase: "prepare_task",
      riskMap: { riskLevel: "high", verificationDepth: "strict", adversarialRequired: true },
      riskLevel: "high",
      phaseBudgetPolicy,
      evidenceRequirements: phaseBudgetPolicy.evidenceRequirements,
      ts: "2026-07-06T02:00:01.000Z",
    }, { dataRoot });
    await appendEvent(cpbRoot, project, job.jobId, {
      type: "completion_gate_evaluated",
      jobId: job.jobId,
      project,
      outcome: "complete",
      reason: "all gates passed",
      completionReport,
      ts: "2026-07-06T02:00:02.000Z",
    }, { dataRoot });
    await completeJob(cpbRoot, project, job.jobId, { ts: "2026-07-06T02:00:03.000Z", dataRoot });

    stream = await startStreamServer({ port: 0, host: "127.0.0.1", cpbRoot, hubRoot, allowAnonymousDev: true });
    const address = stream.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const panelResponse = await fetch(`${baseUrl}/jobs/${project}/${job.jobId}/panel`);
    assert.equal(panelResponse.status, 200);
    assert.match(panelResponse.headers.get("content-type") || "", /text\/html/);
    assert.equal(panelResponse.headers.get("access-control-allow-origin"), null);
    const panelBody = await panelResponse.text();
    assert.match(panelBody, /Job Visibility Panel/);
    assert.match(panelBody, /Completion Report/);
    assert.match(panelBody, /Runtime Policy/);
    assert.match(panelBody, /stream viewer/);
    assert.match(panelBody, /GET \/jobs\/:project\/:jobId\/panel/);
    assert.match(panelBody, /canonical_command, real_path_trace, adversarial_verdict/);
    assert.match(panelBody, /riskSignal=high_product_surface/);
    assert.match(panelBody, /100/);

    const jsonResponse = await fetch(`${baseUrl}/jobs/${project}/${job.jobId}`);
    assert.equal(jsonResponse.status, 200);
    assert.match(jsonResponse.headers.get("content-type") || "", /application\/json/);
    const jsonBody = await jsonResponse.json();
    assert.equal(jsonBody.jobId, job.jobId);
    assert.equal(jsonBody.completionReport.changedFileCount, 1);
    assert.equal(jsonBody.phaseBudgetPolicy.riskLevel, "high");

    const listResponse = await fetch(`${baseUrl}/jobs`);
    assert.equal(listResponse.status, 200);
    assert.match(listResponse.headers.get("content-type") || "", /application\/json/);
    const listBody = await listResponse.json();
    assert.ok(Array.isArray(listBody));
    const listedJob = listBody.find((entry) => entry?.jobId === job.jobId);
    assert.ok(listedJob);
    assert.equal(listedJob.completionReport.changedFileCount, 1);
    assert.equal(listedJob.phaseBudgetPolicy.riskLevel, "high");
  } finally {
    stream?.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("stream server rejects non-loopback binding without a bearer token", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-stream-auth-required-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-stream-auth-required-hub-"));

  try {
    await assert.rejects(
      () => startStreamServer({ port: 0, host: "0.0.0.0", cpbRoot, hubRoot }),
      /bearer token is required/,
    );
    await assert.rejects(
      () => startStreamServer({
        port: 0,
        host: "0.0.0.0",
        cpbRoot,
        hubRoot,
        bearerToken: "test-stream-bearer-token-at-least-32-bytes",
      }),
      /refuses cleartext HTTP on non-loopback hosts/,
    );
    await assert.rejects(
      () => startStreamServer({ port: 0, host: "127.0.0.1", cpbRoot, hubRoot, allowedOrigins: ["*"], allowAnonymousDev: true }),
      /wildcard origin is not allowed/,
    );
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});

test("authenticated stream server protects every endpoint and uses explicit CORS origins", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-stream-auth-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-stream-auth-hub-"));
  const token = "test-stream-bearer-token-at-least-32-bytes";
  const allowedOrigin = "https://cpb-console.example.com";
  let stream: Awaited<ReturnType<typeof startStreamServer>> | null = null;

  try {
    stream = await startStreamServer({
      port: 0,
      host: "0.0.0.0",
      cpbRoot,
      hubRoot,
      bearerToken: token,
      allowedOrigins: [allowedOrigin],
      allowInsecureHttp: true,
    });
    const address = stream.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    for (const endpoint of ["/", "/jobs", "/stream", "/wiki/flow/readme.md"]) {
      const response = await fetch(`${baseUrl}${endpoint}`);
      assert.equal(response.status, 401, `${endpoint} must require Authorization`);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }

    const forbiddenOrigin = await fetch(`${baseUrl}/jobs`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://attacker.example.com",
      },
    });
    assert.equal(forbiddenOrigin.status, 403);
    assert.equal(forbiddenOrigin.headers.get("access-control-allow-origin"), null);

    const jobsResponse = await fetch(`${baseUrl}/jobs`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: allowedOrigin,
      },
    });
    assert.equal(jobsResponse.status, 200);
    assert.equal(jobsResponse.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.notEqual(jobsResponse.headers.get("access-control-allow-origin"), "*");
    assert.equal(jobsResponse.headers.get("vary"), "Origin");

    const preflightResponse = await fetch(`${baseUrl}/jobs`, {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.equal(preflightResponse.status, 204);
    assert.equal(preflightResponse.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.match(preflightResponse.headers.get("access-control-allow-headers") || "", /Authorization/);

    const streamResponse = await fetch(`${baseUrl}/stream`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: allowedOrigin,
      },
    });
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("access-control-allow-origin"), allowedOrigin);
    await streamResponse.body?.cancel();
  } finally {
    stream?.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});
