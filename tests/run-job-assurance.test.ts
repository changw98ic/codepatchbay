import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  buildEvidencePack,
  runHighAssurancePlanning,
  type AssuranceContext,
} from "../core/engine/run-job-assurance.js";
import { withArtifactStoreTestHooks } from "../core/artifacts/artifact-store.js";
import { FailureKind } from "../core/contracts/failure.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function commandFixture(root: string, name: string, label: string) {
  const commandPath = path.join(root, name);
  await writeFile(commandPath, `#!/bin/sh\nprintf '${label} marker=%s' "$CPB_TEST_MARKER"\n`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

function assuranceContext(root: string, env?: NodeJS.ProcessEnv): AssuranceContext {
  return {
    cpbRoot: root,
    project: "project",
    task: "inspect env",
    sourcePath: root,
    dataRoot: null,
    sourceContext: {},
    agents: null,
    timeouts: {},
    env,
    scope: null,
    _attemptId: "attempt",
    getPool: () => null,
    appendEvent: async () => {},
    blockJob: async () => {},
    failJob: async () => {},
    onProgress: null,
  };
}

async function outputFiles(root: string) {
  try {
    return await readdir(path.join(root, "wiki", "outputs"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

test("evidence pack command and subprocess env use explicit job env", async () => {
  const root = await tempRoot("cpb-assurance-env");
  const jobCommand = await commandFixture(root, "job-codegraph", "job");
  const pack = await buildEvidencePack(assuranceContext(root, {
    CPB_CODEGRAPH_COMMAND: jobCommand,
    CPB_TEST_MARKER: "job-marker",
  }));

  assert.equal(pack, "job marker=job-marker");
});

test("evidence pack command falls back to ambient env only when job env is absent", async () => {
  const root = await tempRoot("cpb-assurance-env-fallback");
  const ambientCommand = await commandFixture(root, "ambient-codegraph", "ambient");
  const moduleUrl = new URL("../core/engine/run-job-assurance.js", import.meta.url).href;
  const script = `
    const { buildEvidencePack } = await import(${JSON.stringify(moduleUrl)});
    const pack = await buildEvidencePack({
      cpbRoot: ${JSON.stringify(root)},
      project: "project",
      task: "inspect env",
      sourcePath: ${JSON.stringify(root)},
      dataRoot: null,
      sourceContext: {},
      agents: null,
      timeouts: {},
      scope: null,
      _attemptId: "attempt",
      getPool: () => null,
      appendEvent: async () => {},
      blockJob: async () => {},
      failJob: async () => {},
      onProgress: null,
    });
    process.stdout.write(pack);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      CPB_CODEGRAPH_COMMAND: ambientCommand,
      CPB_TEST_MARKER: "ambient-marker",
    },
  });

  assert.equal(stdout, "ambient marker=ambient-marker");
});

test("evidence pack does not launch CodeGraph when the job signal is pre-aborted", async () => {
  const root = await tempRoot("cpb-assurance-pre-abort");
  const marker = path.join(root, "launched.txt");
  const command = path.join(root, "must-not-launch");
  await writeFile(command, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`, "utf8");
  await chmod(command, 0o755);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    buildEvidencePack({
      ...assuranceContext(root, { CPB_CODEGRAPH_COMMAND: command }),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(await readFile(marker, "utf8").then(() => true, () => false), false);
});

test("disabled high-assurance planning skips even when execution is already aborted", async () => {
  const root = await tempRoot("cpb-assurance-disabled-pre-abort");
  const controller = new AbortController();
  controller.abort();
  let eventCalls = 0;
  const result = await runHighAssurancePlanning({
    ...assuranceContext(root),
    signal: controller.signal,
    appendEvent: async () => { eventCalls += 1; },
  }, {
    jobId: "job-disabled-pre-aborted",
    phaseSourceContext: {},
  });

  assert.equal(result.kind, "skipped");
  assert.equal(eventCalls, 0);
  assert.deepEqual(await outputFiles(root), []);
});

test("enabled high-assurance planning returns runtime_interrupted without event or artifact work when pre-aborted", async () => {
  const root = await tempRoot("cpb-assurance-planning-pre-abort");
  const controller = new AbortController();
  controller.abort();
  let eventCalls = 0;
  const failed = [];
  const ctx: AssuranceContext = {
    ...assuranceContext(root),
    signal: controller.signal,
    appendEvent: async () => { eventCalls += 1; },
    failJob: async (_cpbRoot, _project, _jobId, payload) => { failed.push(payload); },
    getPool: () => ({ execute: async () => ({ output: "must not run" }) }),
  };

  const result = await runHighAssurancePlanning(ctx, {
    jobId: "job-pre-aborted",
    phaseSourceContext: { assurance: { mode: "high" } },
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.result.failure.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.result.failure.retryable, false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(eventCalls, 0);
  assert.deepEqual(await outputFiles(root), []);
});

test("high-assurance planning aborts mid artifact commit without final temp or lock residue", async () => {
  const root = await tempRoot("cpb-assurance-mid-write-abort");
  const dataRoot = path.join(root, "runtime");
  const command = await commandFixture(root, "job-codegraph", "job");
  const controller = new AbortController();
  const failed = [];
  let hookCalls = 0;
  const result = await withArtifactStoreTestHooks({
    afterTempWrite: async ({ path: committedPath }) => {
      if (path.basename(committedPath).startsWith("plan-evidence-pack-")) {
        hookCalls += 1;
        controller.abort();
      }
    },
  }, () => runHighAssurancePlanning({
      ...assuranceContext(root, {
        CPB_CODEGRAPH_COMMAND: command,
        CPB_TEST_MARKER: "mid-write",
      }),
      dataRoot,
      signal: controller.signal,
      failJob: async (_cpbRoot, _project, _jobId, payload) => { failed.push(payload); },
      getPool: () => ({ execute: async () => ({ output: "must not run" }) }),
    }, {
      jobId: "job-mid-write-abort",
      phaseSourceContext: { assurance: { mode: "high" } },
    }));

  assert.equal(result.kind, "failed");
  assert.equal(result.result.failure.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.result.failure.retryable, false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(failed[0].code, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(hookCalls, 1);
  assert.deepEqual(await outputFiles(dataRoot), []);
});
