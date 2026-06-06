import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildPredictions, collectOnce } from "../scripts/swebench-lite/collect.mjs";
import {
  loadDatasetInstances,
  parseEnqueueOutput,
  projectIdForInstance,
  queueIdToJobId,
  readJson,
  readJsonLines,
  runCommand,
  writeJson,
  writeJsonLines,
} from "../scripts/swebench-lite/lib.mjs";
import { tempRoot } from "./helpers.mjs";

test("SWE-bench helper parses CPB enqueue output and derives bounded project ids", () => {
  const parsed = parseEnqueueOutput("Enqueued q-mq157asf-97lu (project=swelite-run-psf-requests-1963)\n");
  assert.deepEqual(parsed, {
    queueId: "q-mq157asf-97lu",
    jobId: "job-q-mq157asf-97lu",
    projectId: "swelite-run-psf-requests-1963",
  });
  assert.equal(queueIdToJobId("job-q"), "job-q");

  const projectId = projectIdForInstance("django__django-12345678901234567890", {
    prefix: "swelite",
    runId: "20260606-cpb-codex-lite-full",
  });
  assert.match(projectId, /^swelite-20260606-cpb-c-django-django-/);
  assert.ok(projectId.length <= 64);
});

test("SWE-bench dataset loader accepts local JSONL and filters instance ids", async () => {
  const root = await tempRoot("cpb-swebench-dataset");
  const datasetPath = path.join(root, "instances.jsonl");
  await writeJsonLines(datasetPath, [
    {
      instance_id: "psf__requests-1963",
      repo: "psf/requests",
      base_commit: "abc123",
      problem_statement: "fix redirects",
    },
    {
      instance_id: "sympy__sympy-1",
      repo: "sympy/sympy",
      base_commit: "def456",
      problem_statement: "fix algebra",
    },
  ]);

  const instances = await loadDatasetInstances({
    datasetPath,
    instanceIds: ["psf__requests-1963"],
  });

  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0], {
    instanceId: "psf__requests-1963",
    repo: "psf/requests",
    baseCommit: "abc123",
    problemStatement: "fix redirects",
  });
});

test("collector converts review bundle diff into patch, prediction, and public trace files", async () => {
  const root = await tempRoot("cpb-swebench-collect");
  const bundle = {
    project: "swelite-run-psf-requests-1963",
    jobId: "job-q-1",
    status: { jobStatus: "completed", completedPhases: ["plan", "execute"] },
    request: { task: "fix redirects" },
    timeline: [{ type: "job_completed", ts: "2026-06-06T00:00:00Z" }],
    evidence: {
      changedFiles: ["requests/sessions.py"],
      diffStat: " requests/sessions.py | 1 +\n",
      diff: "diff --git a/requests/sessions.py b/requests/sessions.py\n+req = prepared_request\n",
      deliverable: "Updated redirect request chaining.",
    },
  };
  const fakeCpb = path.join(root, "fake-cpb.mjs");
  await writeFile(fakeCpb, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(bundle))});\n`, "utf8");
  await chmod(fakeCpb, 0o755);

  const manifest = {
    runId: "cpb-lite-test",
    instances: [{
      instanceId: "psf__requests-1963",
      projectId: "swelite-run-psf-requests-1963",
      jobId: "job-q-1",
      problemStatement: "fix redirects",
      status: "enqueued",
    }],
  };

  const collected = await collectOnce(manifest, root, {
    cpbBin: fakeCpb,
    modelName: "cpb-test",
  });
  assert.equal(collected.instances[0].status, "completed");
  assert.equal(collected.instances[0].patchBytes, bundle.evidence.diff.length);

  const patch = await readFile(collected.instances[0].patchPath, "utf8");
  assert.equal(patch, bundle.evidence.diff);

  const predictions = await buildPredictions(collected, "cpb-test");
  assert.deepEqual(predictions, [{
    instance_id: "psf__requests-1963",
    model_name_or_path: "cpb-test",
    model_patch: bundle.evidence.diff,
  }]);

  const trace = await readFile(collected.instances[0].tracePath, "utf8");
  assert.match(trace, /public execution artifacts only/);
  assert.match(trace, /requests\/sessions.py/);
});

test("collector waits for active retries and collects the latest attempt bundle", async () => {
  const root = await tempRoot("cpb-swebench-retry-collect");
  const hubRoot = path.join(root, "hub");
  const assignmentRoot = path.join(hubRoot, "assignments", "a-q-1");
  await mkdir(path.join(assignmentRoot, "attempts", "001"), { recursive: true });
  await mkdir(path.join(assignmentRoot, "attempts", "002"), { recursive: true });
  await writeJson(path.join(assignmentRoot, "state.json"), { status: "running" });
  await writeJson(path.join(assignmentRoot, "attempts", "001", "result.json"), {
    status: "failed",
    jobResult: { jobId: "job-q-1", status: "failed" },
  });
  await writeJson(path.join(assignmentRoot, "attempts", "002", "heartbeat.json"), {
    activeJobId: "job-q-1-a2",
    status: "running",
  });

  const bundle = {
    project: "swelite-run-pytest",
    jobId: "job-q-1-a2",
    status: { jobStatus: "completed" },
    evidence: {
      diff: "diff --git a/src/_pytest/mark/structures.py b/src/_pytest/mark/structures.py\n+retry diff\n",
    },
  };
  const fakeCpb = path.join(root, "fake-cpb.mjs");
  await writeFile(fakeCpb, `#!/usr/bin/env node
const jobId = process.argv[4];
if (jobId !== "job-q-1-a2") process.exit(3);
console.log(${JSON.stringify(JSON.stringify(bundle))});
`, "utf8");
  await chmod(fakeCpb, 0o755);

  const manifest = {
    runId: "cpb-lite-test",
    instances: [{
      instanceId: "pytest-dev__pytest-10356",
      projectId: "swelite-run-pytest",
      queueId: "q-1",
      jobId: "job-q-1",
      problemStatement: "fix marker MRO",
      status: "enqueued",
    }],
  };

  const previousHubRoot = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    const running = await collectOnce(manifest, root, {
      cpbBin: fakeCpb,
      modelName: "cpb-test",
    });
    assert.equal(running.instances[0].status, "running");
    assert.equal(running.instances[0].patchPath, undefined);

    await writeJson(path.join(assignmentRoot, "state.json"), { status: "completed" });
    const collected = await collectOnce(manifest, root, {
      cpbBin: fakeCpb,
      modelName: "cpb-test",
    });

    assert.equal(collected.instances[0].status, "completed");
    assert.equal(collected.instances[0].bundleJobId, "job-q-1-a2");
    assert.equal(await readFile(collected.instances[0].patchPath, "utf8"), bundle.evidence.diff);
  } finally {
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});

test("pack command creates experiments evaluation/lite submission skeleton", async () => {
  const root = await tempRoot("cpb-swebench-pack");
  const runDir = path.join(root, "run");
  const experimentsDir = path.join(root, "experiments");
  await mkdir(path.join(runDir, "trajs"), { recursive: true });
  await writeJson(path.join(runDir, "manifest.json"), {
    runId: "cpb-lite-pack",
    datasetName: "SWE-bench/SWE-bench_Lite",
    split: "test",
    instances: [{ instanceId: "psf__requests-1963" }],
  });
  await writeFile(path.join(runDir, "all_preds.jsonl"), "{\"instance_id\":\"psf__requests-1963\",\"model_patch\":\"diff\",\"model_name_or_path\":\"cpb\"}\n", "utf8");
  await writeFile(path.join(runDir, "trajs", "psf__requests-1963.md"), "# trace\n", "utf8");

  await runCommand(process.execPath, [
    path.resolve("scripts/swebench-lite/pack.mjs"),
    "--run-dir", runDir,
    "--experiments-dir", experimentsDir,
    "--submission-name", "20260606_cpb_test",
    "--model-name", "CPB Test",
  ], { quiet: true });

  const target = path.join(experimentsDir, "evaluation", "lite", "20260606-cpb-test");
  assert.equal((await readJsonLines(path.join(target, "all_preds.jsonl"))).length, 1);
  assert.match(await readFile(path.join(target, "metadata.yaml"), "utf8"), /model_name: "CPB Test"/);
  assert.match(await readFile(path.join(target, "README.md"), "utf8"), /does not pass gold patches/);
  assert.match(await readFile(path.join(target, "logs", "README.md"), "utf8"), /No official SWE-bench/);
});
