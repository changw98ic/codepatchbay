import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { assertProviderAvailable, readProviderQuotas } from "../server/services/provider-quota.js";
import { readProviderUsageRollup } from "../server/services/provider-usage.js";
import { validateWorkerBrokerEvent } from "../server/services/hub/worker-state-broker.js";
import { isBrokerArtifactEntry } from "../shared/orchestrator/artifact-index.js";
import { WorkerBrokerClient } from "../shared/orchestrator/worker-broker-client.js";
import { tempRoot } from "./helpers.js";

const VALID_BROKER_TOKEN = "a".repeat(43);

function brokerClientWithResult(result: unknown) {
  return new WorkerBrokerClient({
    url: "http://127.0.0.1:12345",
    token: VALID_BROKER_TOKEN,
    workerId: "worker-1",
    incarnationToken: "incarnation-1",
  }, {
    fetch: async () => new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}

test("worker broker client rejects success envelopes without a result field", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const client = new WorkerBrokerClient({
      url: "http://127.0.0.1:12345",
      token: VALID_BROKER_TOKEN,
      workerId: "worker-1",
      incarnationToken: "incarnation-1",
    });

    await assert.rejects(
      client.getArtifactIndex("/tmp/cpb", "flow", "job-1"),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "WORKER_BROKER_CONTRACT_INVALID");
        assert.match(String((err as Error).message), /missing result/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("worker broker client rejects HTTP 200 envelopes that do not declare ok=true", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, result: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const client = new WorkerBrokerClient({
      url: "http://127.0.0.1:12345",
      token: VALID_BROKER_TOKEN,
      workerId: "worker-1",
      incarnationToken: "incarnation-1",
    });
    await assert.rejects(client.hasInboxWork("worker-1"), {
      code: "WORKER_BROKER_CONTRACT_INVALID",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("worker broker job.create rejects malformed job records before engine state consumes them", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    result: { status: "pending" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const client = new WorkerBrokerClient({
      url: "http://127.0.0.1:12345",
      token: VALID_BROKER_TOKEN,
      workerId: "worker-1",
      incarnationToken: "incarnation-1",
    });
    await assert.rejects(
      client.createJob("/tmp/cpb", { project: "flow", jobId: "job-1" }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "WORKER_BROKER_CONTRACT_INVALID");
        assert.match(String((err as Error).message), /job\.create.*jobId/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("worker broker project.get rejects malformed runtime-root records", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    result: { sourcePath: 42, projectRuntimeRoot: null },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const client = new WorkerBrokerClient({
      url: "http://127.0.0.1:12345",
      token: VALID_BROKER_TOKEN,
      workerId: "worker-1",
      incarnationToken: "incarnation-1",
    });
    await assert.rejects(client.getProject("flow"), {
      code: "WORKER_BROKER_CONTRACT_INVALID",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("worker broker project.get accepts an explicitly scoped project identity", async () => {
  assert.deepEqual(
    await brokerClientWithResult({
      projectId: "flow",
      sourcePath: null,
      projectRuntimeRoot: "/runtime/flow",
    }).getProject("flow"),
    {
      projectId: "flow",
      sourcePath: null,
      projectRuntimeRoot: "/runtime/flow",
    },
  );
});

test("worker broker rejects successful responses with mismatched project or job identities", async () => {
  await assert.rejects(
    brokerClientWithResult({
      projectId: "other",
      sourcePath: null,
      projectRuntimeRoot: "/runtime/other",
    }).getProject("flow"),
    { code: "WORKER_BROKER_CONTRACT_INVALID" },
  );

  await assert.rejects(
    brokerClientWithResult({ jobId: "job-other" }).createJob("/tmp/cpb", {
      project: "flow",
      jobId: "job-1",
    }),
    { code: "WORKER_BROKER_CONTRACT_INVALID" },
  );

  await assert.rejects(
    brokerClientWithResult({ jobId: "job-other" }).startPhase(
      "/tmp/cpb",
      "flow",
      "job-1",
      { phase: "plan" },
    ),
    { code: "WORKER_BROKER_CONTRACT_INVALID" },
  );
});

test("worker broker artifact index rejects malformed result entries before returning them", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    result: { entries: [{ kind: "verdict", path: 42, exists: true, broken: false }] },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const client = new WorkerBrokerClient({
      url: "http://127.0.0.1:12345",
      token: VALID_BROKER_TOKEN,
      workerId: "worker-1",
      incarnationToken: "incarnation-1",
    });

    await assert.rejects(
      client.getArtifactIndex("/tmp/cpb", "flow", "job-1"),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "ARTIFACT_INDEX_CONTRACT_INVALID");
        assert.match(String((err as Error).message), /worker broker artifact\.index/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("artifact index entry guard rejects malformed artifact metadata", () => {
  assert.equal(isBrokerArtifactEntry({
    id: "artifact-1",
    kind: "acceptance-checklist",
    phase: "verify",
    path: 42,
    sha256: null,
    createdAt: "not-a-date",
    producerAgent: null,
    exists: true,
    broken: false,
    reason: null,
    eventType: null,
    attemptId: "attempt-1",
    artifactKind: "acceptance-checklist",
  }), false);
});

test("worker broker event ingress rejects malformed artifact metadata before persistence", () => {
  assert.throws(
    () => validateWorkerBrokerEvent({
      type: "artifact_created",
      artifact: "verdict-1",
      artifactKind: 42,
      ts: "not-a-date",
    }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "HUB_WORKER_BROKER_REQUEST_INVALID");
      assert.match(String((err as Error).message), /artifactKind|timestamp/i);
      return true;
    },
  );
  assert.throws(
    () => validateWorkerBrokerEvent({
      type: "artifact_created",
      artifactKind: "verdict",
      ts: "2026-07-20T00:00:00.000Z",
    }),
    { code: "HUB_WORKER_BROKER_REQUEST_INVALID" },
  );
  assert.throws(
    () => validateWorkerBrokerEvent({
      type: "artifact_created",
      artifact: "verdict-1.md",
      ts: "2026-07-20T00:00:00.000Z",
    }),
    { code: "HUB_WORKER_BROKER_REQUEST_INVALID" },
  );
});

test("provider quota reader rejects malformed quota state with a named diagnostic", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-contract");
  await mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await writeFile(path.join(hubRoot, "providers", "quotas.json"), `${JSON.stringify([
    { providerKey: "codex", status: "auth_error", reason: "array is not a keyed quota map" },
  ])}\n`, "utf8");

  await assert.rejects(
    readProviderQuotas(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTAS_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /provider quotas/i);
      return true;
    },
  );
});

test("provider availability fails closed when quota entries are malformed", async () => {
  const hubRoot = await tempRoot("cpb-provider-availability-contract");
  await mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await writeFile(path.join(hubRoot, "providers", "quotas.json"), `${JSON.stringify({
    codex: {
      providerKey: "codex",
      status: "auth_error",
      nextEligibleAt: "not-a-number",
      confidence: "certain",
      reason: "malformed quota fields",
    },
  })}\n`, "utf8");

  await assert.rejects(
    assertProviderAvailable(hubRoot, { providerKey: "codex", agent: "codex" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTA_ENTRY_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /codex/i);
      return true;
    },
  );
});

test("provider usage rollup rejects malformed JSONL records instead of reporting unknown provider state", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-contract");
  await mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await writeFile(path.join(hubRoot, "providers", "usage.jsonl"), [
    JSON.stringify({ providerKey: "codex", status: "ok", usage: { calls: 1, totalTokens: 12 } }),
    JSON.stringify({ status: "ok", usage: { calls: "many", totalTokens: -5 } }),
    "{bad json",
    "",
  ].join("\n"), "utf8");

  await assert.rejects(
    readProviderUsageRollup(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_USAGE_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /usage\.jsonl/i);
      return true;
    },
  );
});
