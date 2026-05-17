import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { registerProject } from "../server/services/hub-registry.js";
import { listDispatches } from "../server/services/dispatch-state.js";

const execFileAsync = promisify(execFile);

test("run-pipeline rejects a non-directory --source-path before creating a job", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-boundary-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-cpb-"));
  const filePath = path.join(dir, "not-a-directory.txt");
  await writeFile(filePath, "not a directory", "utf8");

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      "bridges/run-pipeline.mjs",
      "--project", "calc-test",
      "--task", "noop",
      "--source-path", filePath,
    ], { cwd: process.cwd(), env: { ...process.env, CPB_ROOT: cpbRoot } }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--source-path is not a directory/);
      return true;
    },
  );

  await assert.rejects(
    () => access(path.join(cpbRoot, "cpb-task", "events", "calc-test")),
    /ENOENT/,
  );
});

test("run-pipeline rejects --source-path that conflicts with an existing wiki project binding", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-cpb-canonical-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-source-"));
  const otherSourcePath = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-other-source-"));
  const canonical = await realpath(sourcePath);
  const project = "canonical-test";
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  await mkdir(wikiDir, { recursive: true });
  await writeFile(
    path.join(wikiDir, "project.json"),
    JSON.stringify({ name: project, sourcePath: canonical, custom: "keep-me" }, null, 2),
    "utf8",
  );

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      "bridges/run-pipeline.mjs",
      "--project", project,
      "--task", "noop",
      "--source-path", otherSourcePath,
      "--workflow", "blocked",
    ], { cwd: process.cwd(), env: { ...process.env, CPB_ROOT: cpbRoot } }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /project\/sourcePath mismatch/);
      return true;
    },
  );

  const projectJson = JSON.parse(await readFile(path.join(wikiDir, "project.json"), "utf8"));
  assert.equal(projectJson.sourcePath, canonical);
  assert.equal(projectJson.custom, "keep-me");
});

test("run-pipeline rejects --source-path that conflicts with Hub project registry binding", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-cpb-hub-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-source-hub-"));
  const otherSourcePath = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-other-hub-"));
  const project = await registerProject(hubRoot, { name: "hub-boundary", sourcePath });

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      "bridges/run-pipeline.mjs",
      "--project", project.id,
      "--task", "noop",
      "--source-path", otherSourcePath,
      "--workflow", "blocked",
    ], { cwd: process.cwd(), env: { ...process.env, CPB_ROOT: cpbRoot, CPB_HUB_ROOT: hubRoot } }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /project\/sourcePath mismatch/);
      return true;
    },
  );
});

test("run-pipeline creates dispatch record when dispatch enabled and sourcePath matches Hub", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-src-"));
  await registerProject(hubRoot, { name: "dispatch-proj", sourcePath });

  const env = {
    ...process.env,
    CPB_ROOT: cpbRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_WORKER_DISPATCH_ENABLED: "1",
  };

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "bridges/run-pipeline.mjs",
    "--project", "dispatch-proj",
    "--task", "test dispatch",
    "--source-path", sourcePath,
    "--workflow", "blocked",
  ], { cwd: process.cwd(), env });

  const dispatches = await listDispatches(hubRoot);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].projectId, "dispatch-proj");
  assert.equal(dispatches[0].status, "completed");
});

test("run-pipeline rejects sourcePath when dispatch guard detects mismatch", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-guard-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-guard-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-guard-src-"));
  const otherPath = await mkdtemp(path.join(tmpdir(), "cpb-rp-dispatch-guard-other-"));
  await registerProject(hubRoot, { name: "guard-proj", sourcePath });

  const env = {
    ...process.env,
    CPB_ROOT: cpbRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_WORKER_DISPATCH_ENABLED: "1",
  };

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      "bridges/run-pipeline.mjs",
      "--project", "guard-proj",
      "--task", "should fail",
      "--source-path", otherPath,
      "--workflow", "blocked",
    ], { cwd: process.cwd(), env }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /sourcePath mismatch/);
      return true;
    },
  );

  const dispatches = await listDispatches(hubRoot);
  assert.equal(dispatches.length, 0);
});

test("run-pipeline works without dispatch when CPB_WORKER_DISPATCH_ENABLED is unset", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-rp-nodispatch-cpb-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-rp-nodispatch-src-"));

  const env = {
    ...process.env,
    CPB_ROOT: cpbRoot,
  };
  delete env.CPB_WORKER_DISPATCH_ENABLED;
  delete env.CPB_HUB_ROOT;

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "bridges/run-pipeline.mjs",
    "--project", "compat-proj",
    "--task", "compat test",
    "--source-path", sourcePath,
    "--workflow", "blocked",
  ], { cwd: process.cwd(), env });
});
