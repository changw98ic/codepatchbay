import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { getManagedAcpPool, resetManagedAcpPoolsForTests } from "../server/services/acp-pool-runtime.js";
import { enqueue } from "../server/services/hub-queue.js";
import { heartbeatWorker, registerProject } from "../server/services/hub-registry.js";
import { buildDiagnosticBundle, redactDiagnostics } from "../server/services/observability.js";

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
