import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { registerDagWorkflow } from "../core/workflow/definition.js";
import { createJob, completePhase, getJob, startPhase } from "../server/services/job-store.js";
import { acquireLease } from "../server/services/lease-manager.js";
import { recoverJobs, recoverOneJob } from "../server/services/supervisor.js";

const PROJECT = "test-proj";

describe("supervisor DAG recovery", () => {
  let tmpRoot;
  let workflowCounter = 0;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-supervisor-dag-"));
    process.env.CPB_ROOT = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.CPB_ROOT;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function registerLinearDag() {
    workflowCounter += 1;
    const workflow = `m3-r2-dag-${process.pid}-${workflowCounter}`;
    registerDagWorkflow(workflow, {
      nodes: [
        { id: "plan", phase: "plan", dependsOn: [] },
        { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
        { id: "verify", phase: "verify", dependsOn: ["exec-a"] },
      ],
      maxConcurrentNodes: 1,
    });
    return workflow;
  }

  async function createRunningExecJob({ lease = "none", now = new Date() } = {}) {
    const workflow = registerLinearDag();
    const job = await createJob(tmpRoot, {
      project: PROJECT,
      task: "recover dag node",
      workflow,
    });

    await startPhase(tmpRoot, PROJECT, job.jobId, {
      phase: "plan",
      leaseId: `lease-${job.jobId}-plan`,
      ts: new Date(now.getTime() - 5_000).toISOString(),
    });
    await completePhase(tmpRoot, PROJECT, job.jobId, {
      phase: "plan",
      artifact: "plan-001",
      ts: new Date(now.getTime() - 4_000).toISOString(),
    });
    await startPhase(tmpRoot, PROJECT, job.jobId, {
      phase: "exec-a",
      leaseId: `lease-${job.jobId}-exec-a`,
      ts: new Date(now.getTime() - 3_000).toISOString(),
    });

    if (lease === "active") {
      await acquireLease(tmpRoot, {
        leaseId: `lease-${job.jobId}-exec-a`,
        jobId: job.jobId,
        phase: "exec-a",
        ttlMs: 60_000,
        now,
      });
    } else if (lease === "stale") {
      await acquireLease(tmpRoot, {
        leaseId: `lease-${job.jobId}-exec-a`,
        jobId: job.jobId,
        phase: "exec-a",
        ttlMs: 1,
        now: new Date(now.getTime() - 60_000),
      });
    }

    return getJob(tmpRoot, PROJECT, job.jobId);
  }

  async function createFakeExecutorRoot() {
    const executorRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-fake-executor-"));
    const bridgesDir = path.join(executorRoot, "bridges");
    await mkdir(bridgesDir, { recursive: true });
    await writeFile(path.join(bridgesDir, "run-phase.mjs"), "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await writeFile(
      path.join(bridgesDir, "job-runner.mjs"),
      [
        "#!/usr/bin/env node",
        "import { appendFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "const args = process.argv.slice(2);",
        "const cpbRoot = args[args.indexOf('--cpb-root') + 1];",
        "const phase = args[args.indexOf('--phase') + 1];",
        "await appendFile(path.join(cpbRoot, 'recovery-calls.txt'), `${phase}\\n`, 'utf8');",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );
    return executorRoot;
  }

  async function createSelectiveFailureExecutorRoot(failingPhase) {
    const executorRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-fake-executor-"));
    const bridgesDir = path.join(executorRoot, "bridges");
    await mkdir(bridgesDir, { recursive: true });
    await writeFile(path.join(bridgesDir, "run-phase.mjs"), "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await writeFile(
      path.join(bridgesDir, "job-runner.mjs"),
      [
        "#!/usr/bin/env node",
        "import { appendFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "const args = process.argv.slice(2);",
        "const cpbRoot = args[args.indexOf('--cpb-root') + 1];",
        "const phase = args[args.indexOf('--phase') + 1];",
        "await appendFile(path.join(cpbRoot, 'recovery-calls.txt'), `${phase}\\n`, 'utf8');",
        `process.exit(phase === ${JSON.stringify(failingPhase)} ? 1 : 0);`,
        "",
      ].join("\n"),
      "utf8",
    );
    return executorRoot;
  }

  it("does not recover a DAG running node while its lease is active", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const job = await createRunningExecJob({ lease: "active", now });

    const recoverable = await recoverJobs(tmpRoot, { now });

    assert.equal(recoverable.some((entry) => entry.jobId === job.jobId), false);
  });

  it("recovers a DAG running node when its lease is missing", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const job = await createRunningExecJob({ lease: "none", now });

    const recoverable = await recoverJobs(tmpRoot, { now });

    assert.equal(recoverable.some((entry) => entry.jobId === job.jobId), true);
  });

  it("recovers a DAG running node when its lease is stale", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const job = await createRunningExecJob({ lease: "stale", now });

    const recoverable = await recoverJobs(tmpRoot, { now });

    assert.equal(recoverable.some((entry) => entry.jobId === job.jobId), true);
  });

  it("recoverOneJob runs every ready DAG node once", async () => {
    const workflow = `m3-r4-fanout-${process.pid}-${++workflowCounter}`;
    registerDagWorkflow(workflow, {
      nodes: [
        { id: "plan", phase: "plan", dependsOn: [] },
        { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
        { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
        { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
      ],
      maxConcurrentNodes: 2,
    });
    const executorRoot = await createFakeExecutorRoot();
    const callsFile = path.join(tmpRoot, "recovery-calls.txt");
    try {
      const job = await createJob(tmpRoot, {
        project: PROJECT,
        task: "recover fan-out DAG",
        workflow,
      });
      await startPhase(tmpRoot, PROJECT, job.jobId, {
        phase: "plan",
        leaseId: `lease-${job.jobId}-plan`,
      });
      await completePhase(tmpRoot, PROJECT, job.jobId, {
        phase: "plan",
        artifact: "plan-001",
      });

      const state = await getJob(tmpRoot, PROJECT, job.jobId);
      const result = await recoverOneJob(tmpRoot, state, { executorRoot });
      const calls = (await readFile(callsFile, "utf8")).trim().split("\n").sort();

      assert.equal(result.exitCode, 0);
      assert.deepEqual(calls, ["exec-a", "exec-b"]);
      assert.deepEqual(result.nodes.map((node) => node.phase).sort(), ["exec-a", "exec-b"]);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
    }
  });

  it("recoverOneJob attempts every ready DAG node even when one sibling fails", async () => {
    const workflow = `m3-r4-fanout-failure-${process.pid}-${++workflowCounter}`;
    registerDagWorkflow(workflow, {
      nodes: [
        { id: "plan", phase: "plan", dependsOn: [] },
        { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
        { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
        { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
      ],
      maxConcurrentNodes: 2,
    });
    const executorRoot = await createSelectiveFailureExecutorRoot("exec-a");
    const callsFile = path.join(tmpRoot, "recovery-calls.txt");
    try {
      const job = await createJob(tmpRoot, {
        project: PROJECT,
        task: "recover fan-out DAG with one sibling failure",
        workflow,
      });
      await startPhase(tmpRoot, PROJECT, job.jobId, {
        phase: "plan",
        leaseId: `lease-${job.jobId}-plan`,
      });
      await completePhase(tmpRoot, PROJECT, job.jobId, {
        phase: "plan",
        artifact: "plan-001",
      });

      const state = await getJob(tmpRoot, PROJECT, job.jobId);
      const result = await recoverOneJob(tmpRoot, state, { executorRoot });
      const calls = (await readFile(callsFile, "utf8")).trim().split("\n").sort();

      assert.equal(result.exitCode, 1);
      assert.deepEqual(calls, ["exec-a", "exec-b"]);
      assert.deepEqual(result.nodes.map((node) => node.phase).sort(), ["exec-a", "exec-b"]);
      assert.deepEqual(
        result.nodes.map((node) => [node.phase, node.exitCode]).sort(),
        [["exec-a", 1], ["exec-b", 0]],
      );
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
    }
  });

  it("recoverOneJob resumes stale running DAG nodes without rerunning completed nodes", async () => {
    const workflow = `m3-r5-stale-running-${process.pid}-${++workflowCounter}`;
    registerDagWorkflow(workflow, {
      nodes: [
        { id: "plan", phase: "plan", dependsOn: [] },
        { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
        { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
        { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
      ],
      maxConcurrentNodes: 2,
    });
    const executorRoot = await createFakeExecutorRoot();
    const callsFile = path.join(tmpRoot, "recovery-calls.txt");
    try {
      const job = await createJob(tmpRoot, {
        project: PROJECT,
        task: "recover interrupted fan-out DAG",
        workflow,
      });
      await startPhase(tmpRoot, PROJECT, job.jobId, {
        phase: "plan",
        leaseId: `lease-${job.jobId}-plan`,
      });
      await completePhase(tmpRoot, PROJECT, job.jobId, {
        phase: "plan",
        artifact: "plan-001",
      });
      await startPhase(tmpRoot, PROJECT, job.jobId, {
        phase: "exec-a",
        leaseId: `lease-${job.jobId}-exec-a`,
      });
      await completePhase(tmpRoot, PROJECT, job.jobId, {
        phase: "exec-a",
        artifact: "deliverable-a",
      });
      await startPhase(tmpRoot, PROJECT, job.jobId, {
        phase: "exec-b",
        leaseId: `lease-${job.jobId}-exec-b`,
      });
      await acquireLease(tmpRoot, {
        leaseId: `lease-${job.jobId}-exec-b`,
        jobId: job.jobId,
        phase: "exec-b",
        ttlMs: 1,
        now: new Date("2026-01-01T00:00:00Z"),
      });

      const state = await getJob(tmpRoot, PROJECT, job.jobId);
      const recoverable = await recoverJobs(tmpRoot);
      assert.equal(recoverable.some((entry) => entry.jobId === job.jobId), true);

      const result = await recoverOneJob(tmpRoot, state, { executorRoot });
      const calls = (await readFile(callsFile, "utf8")).trim().split("\n");

      assert.equal(result.exitCode, 0);
      assert.deepEqual(calls, ["exec-b"]);
      assert.equal(result.phase, "exec-b");
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
    }
  });
});
