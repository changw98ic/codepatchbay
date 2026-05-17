import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { getManagedAcpPool, resetManagedAcpPoolsForTests } from "../server/services/acp-pool-runtime.js";
import { enqueue } from "../server/services/hub-queue.js";
import { heartbeatWorker, registerProject } from "../server/services/hub-registry.js";
import { buildDiagnosticBundle, buildObservabilitySummary, redactDiagnostics } from "../server/services/observability.js";
import { createDispatch, assignWorker, startDispatch, completeDispatch } from "../server/services/dispatch-state.js";

afterEach(() => {
  resetManagedAcpPoolsForTests();
});

test("diagnostic bundle summarizes Hub state and redacts secrets", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-diagnostics-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-diagnostics-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-diagnostics-project-"));
  const project = await registerProject(hubRoot, { name: "diag-project", sourcePath });
  await heartbeatWorker(hubRoot, project.id, {
    workerId: "worker-diag",
    capabilities: ["scan"],
  });
  await enqueue(hubRoot, {
    projectId: project.id,
    sourcePath,
    description: "inspect diagnostics",
    metadata: {
      webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-value",
    },
  });

  const pool = getManagedAcpPool({ cpbRoot, hubRoot });
  await pool.noteRateLimit("claude", new Error("429 Authorization: Bearer sk-secret-token retry after 60 seconds"));

  const bundle = await buildDiagnosticBundle({ cpbRoot, hubRoot, acpPool: pool });

  assert.equal(bundle.hub.projectCount, 1);
  assert.equal(bundle.projects[0].workerDerivedStatus, "online");
  assert.equal(bundle.queue.pending, 1);
  assert.equal(bundle.acp.mode, "managed-shared");
  assert.match(bundle.acp.rateLimits.claude.reason, /Bearer \[REDACTED\]/);

  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /sk-secret-token|secret-value/);
  assert.equal(bundle.queueEntries[0].metadata.webhookUrl, "[REDACTED]");
});

test("redactDiagnostics redacts sensitive header-like keys recursively", () => {
  const redacted = redactDiagnostics({
    req: {
      headers: {
        authorization: "Bearer abc",
        cookie: "sid=123",
      },
    },
    message: "api_key=abc123 retry",
  });

  assert.equal(redacted.req.headers.authorization, "[REDACTED]");
  assert.equal(redacted.req.headers.cookie, "[REDACTED]");
  assert.equal(redacted.message, "api_key=[REDACTED] retry");
});

test("buildObservabilitySummary returns workers, pools, queue, and dispatch summary", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-obs-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-obs-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-obs-project-"));

  const project = await registerProject(hubRoot, { name: "obs-project", sourcePath });
  await heartbeatWorker(hubRoot, project.id, {
    workerId: "worker-obs",
    capabilities: ["scan"],
  });
  await enqueue(hubRoot, {
    projectId: project.id,
    sourcePath,
    description: "test observability",
  });

  const dispatch1 = await createDispatch(hubRoot, { projectId: project.id, sourcePath });
  await assignWorker(hubRoot, dispatch1.dispatchId, { workerId: "w1" });
  await startDispatch(hubRoot, dispatch1.dispatchId);
  await completeDispatch(hubRoot, dispatch1.dispatchId);

  const dispatch2 = await createDispatch(hubRoot, { projectId: project.id, sourcePath });
  await startDispatch(hubRoot, dispatch2.dispatchId);

  const pool = getManagedAcpPool({ cpbRoot, hubRoot });
  const summary = await buildObservabilitySummary({ cpbRoot, hubRoot, acpPool: pool });

  assert.ok(summary.generatedAt);
  assert.equal(summary.workers.online, 1);
  assert.equal(summary.workers.stale, 0);
  assert.equal(summary.workers.offline, 0);
  assert.equal(summary.workers.details.length, 1);
  assert.equal(summary.workers.details[0].id, project.id);
  assert.equal(summary.workers.details[0].status, "online");
  assert.ok(summary.workers.details[0].ageMs >= 0);
  assert.equal(summary.workers.details[0].workerId, "worker-obs");

  assert.equal(summary.queue.pending, 1);
  assert.equal(summary.queue.total, 1);

  assert.ok(summary.pools);
  assert.ok(summary.rateLimits);

  assert.equal(summary.dispatchSummary.total, 2);
  assert.equal(summary.dispatchSummary.completed, 1);
  assert.equal(summary.dispatchSummary.running, 1);
});

test("buildObservabilitySummary pool lifecycle fields include requestCount and processAge", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-obs-lifecycle-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-obs-lifecycle-hub-"));

  const pool = getManagedAcpPool({ cpbRoot, hubRoot });
  pool.requestCount.set("codex", 42);
  pool.errorCount.set("codex", 2);
  pool.recycleCount.set("codex", 5);

  const summary = await buildObservabilitySummary({ cpbRoot, hubRoot, acpPool: pool });

  assert.equal(summary.pools.codex.requestCount, 42);
  assert.equal(summary.pools.codex.errorCount, 2);
  assert.equal(summary.pools.codex.recycleCount, 5);
  assert.ok(typeof summary.pools.codex.activeRequests === "number");
  assert.ok(summary.pools.codex.mode);
  assert.ok(summary.pools.codex.limit >= 1);
});
