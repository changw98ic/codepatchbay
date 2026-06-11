// @ts-nocheck
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { AcpSupervisor } from "../server/orchestrator/acp-supervisor.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";
import { HubOrchestrator } from "../server/orchestrator/hub-orchestrator.js";
import { AcpPool } from "../server/services/acp-pool.js";
import { tempRoot, readJson } from "./helpers.js";

function supervisorInput() {
  return {
    assignment: {
      assignmentId: "a-q-1",
      entryId: "q-1",
      projectId: "proj",
      task: "fix failing CPB workflow",
      workflow: "standard",
      planMode: "full",
      attempts: 0,
    },
    attempt: { attempt: 1 },
    result: {
      failure: {
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "execute",
        reason: "agent returned invalid contract",
        retryable: true,
      },
    },
  };
}

test("AcpSupervisor uses the control-plane agent and provider scope", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-hub");
  const calls = [];
  const pool = {
    async execute(agent, prompt, cwd, timeoutMs, options) {
      calls.push({ agent, prompt, cwd, timeoutMs, options });
      return {
        output: JSON.stringify({
          action: "restart_worker_and_retry",
          reason: "supervisor diagnosed retry",
          confidence: 0.8,
          params: {},
        }),
      };
    },
  };

  const supervisor = new AcpSupervisor({ cpbRoot, hubRoot, pool });
  const decision = await supervisor.diagnoseFailure(supervisorInput());

  assert.equal(decision.action, "restart_worker_and_retry");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, "codex");
  assert.equal(calls[0].cwd, cpbRoot);
  assert.equal(calls[0].options.role, "supervisor");
  assert.equal(calls[0].options.phase, "supervisor_diagnose");
  assert.equal(calls[0].options.poolScope, "control-plane");
  assert.equal(calls[0].options.controlPlane, true);
  assert.equal(calls[0].options.providerKey, "codex:control-plane");
});

test("AcpSupervisor start writes resident health from pool state and quotas", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-start-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-start-hub");
  const pool = {
    async start() {
      return { ok: true };
    },
    status() {
      return {
        providerProcessReuse: true,
        pools: {
          codex: { active: 0, limit: 1, providerKey: "codex" },
        },
      };
    },
    async readProviderQuotas() {
      return {
        "codex:control-plane": {
          providerKey: "codex:control-plane",
          status: "available",
          reason: "",
        },
      };
    },
    async connectionLeaseStatus() {
      return {
        total: 1,
        providers: { "codex:control-plane": 1 },
      };
    },
  };

  const supervisor = new AcpSupervisor({ cpbRoot, hubRoot, pool });
  const state = await supervisor.start();
  const persisted = await readJson(path.join(hubRoot, "supervisor", "state.json"));

  assert.equal(state.status, "healthy");
  assert.equal(state.agent, "codex");
  assert.equal(state.providerKey, "codex:control-plane");
  assert.equal(state.poolScope, "control-plane");
  assert.equal(state.providerHealth["codex:control-plane"].status, "available");
  assert.equal(state.connectionLeases.providers["codex:control-plane"], 1);
  assert.equal(persisted.status, "healthy");
  assert.equal(persisted.kind, "resident_supervisor");
});

test("AcpSupervisor falls back to deterministic routing on invalid decisions", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-invalid-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-invalid-hub");
  const pool = {
    async execute() {
      return {
        output: JSON.stringify({
          action: "reroute",
          reason: "bad reroute missing params",
          confidence: 0.7,
          params: {},
        }),
      };
    },
  };
  const router = new FailureRouter(new AcpSupervisor({ cpbRoot, hubRoot, pool }));

  const decision = await router.route(supervisorInput());

  assert.equal(decision.action, "restart_worker_and_retry");
  assert.match(decision.reason, /agent_contract_invalid/);
});

test("AcpSupervisor saves invalid JSON and falls back to deterministic routing", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-invalid-json-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-invalid-json-hub");
  const pool = {
    async execute() {
      return { output: "this is not json" };
    },
  };
  const router = new FailureRouter(new AcpSupervisor({ cpbRoot, hubRoot, pool }));

  const decision = await router.route(supervisorInput());
  const decisionFiles = await readdir(path.join(hubRoot, "supervisor", "decisions"));
  const saved = await readJson(path.join(hubRoot, "supervisor", "decisions", decisionFiles[0]));

  assert.equal(decision.action, "restart_worker_and_retry");
  assert.equal(saved.validation.valid, false);
  assert.match(saved.validation.errors.join(";"), /not valid JSON/);
});

test("AcpSupervisor falls back to deterministic routing when ACP execution fails", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-error-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-error-hub");
  const pool = {
    async execute() {
      throw new Error("control-plane provider unavailable");
    },
  };
  const router = new FailureRouter(new AcpSupervisor({ cpbRoot, hubRoot, pool }));

  const decision = await router.route(supervisorInput());

  assert.equal(decision.action, "restart_worker_and_retry");
  assert.match(decision.reason, /agent_contract_invalid/);
});

test("AcpSupervisor saves valid decisions for reconciler audit and handoff", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-decision-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-decision-hub");
  const pool = {
    async execute() {
      return {
        output: JSON.stringify({
          action: "restart_worker_and_retry",
          reason: "diagnosed stale worker",
          confidence: 0.9,
          params: {},
        }),
      };
    },
  };
  const supervisor = new AcpSupervisor({ cpbRoot, hubRoot, pool });

  const decision = await supervisor.diagnoseFailure(supervisorInput());
  const decisionFiles = await readdir(path.join(hubRoot, "supervisor", "decisions"));
  const saved = await readJson(path.join(hubRoot, "supervisor", "decisions", decisionFiles[0]));

  assert.equal(decision.action, "restart_worker_and_retry");
  assert.equal(saved.validation.valid, true);
  assert.equal(saved.rawDecision.reason, "diagnosed stale worker");
  assert.equal(saved.assignmentId, "a-q-1");
  assert.equal(saved.entryId, "q-1");
});

test("AcpPool isolates control-plane provider keys from worker provider capacity", async () => {
  const cpbRoot = await tempRoot("cpb-supervisor-pool-cpb");
  const hubRoot = await tempRoot("cpb-supervisor-pool-hub");
  let releaseWorker;
  let workerStarted;
  const workerStartedPromise = new Promise((resolve) => { workerStarted = resolve; });
  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    providerConnectionLimit: 1,
    runner: async ({ prompt }) => {
      if (prompt === "worker") {
        workerStarted();
        await new Promise((resolve) => { releaseWorker = resolve; });
      }
      return prompt;
    },
  });

  const worker = pool.execute("codex", "worker", cpbRoot, 0);
  await workerStartedPromise;

  try {
    const control = await Promise.race([
      pool.execute("codex", "control", cpbRoot, 0, {
        providerKey: "codex:control-plane",
        poolScope: "control-plane",
        controlPlane: true,
        waitTimeoutMs: 20,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("control-plane request waited on worker provider slot")), 80)),
    ]);
    assert.equal(control.output, "control");
  } finally {
    if (releaseWorker) releaseWorker();
    await worker;
    await pool.stop();
  }
});

test("HubOrchestrator starts resident supervisor and exposes health in status", async () => {
  const cpbRoot = await tempRoot("cpb-orch-supervisor-cpb");
  const hubRoot = await tempRoot("cpb-orch-supervisor-hub");
  let started = 0;
  const fakeSupervisor = {
    async start() {
      started += 1;
      return {
        status: "healthy",
        agent: "codex",
        providerKey: "codex:control-plane",
        poolScope: "control-plane",
      };
    },
    status() {
      return {
        status: "healthy",
        agent: "codex",
        providerKey: "codex:control-plane",
        poolScope: "control-plane",
      };
    },
    diagnoseFailure: async () => null,
  };
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { acpSupervisor: fakeSupervisor });

  await orchestrator.start();
  try {
    const status = await orchestrator.status();

    assert.equal(started, 1);
    assert.equal(status.supervisor.status, "healthy");
    assert.equal(status.supervisor.providerKey, "codex:control-plane");
  } finally {
    await orchestrator.stop();
  }
});
