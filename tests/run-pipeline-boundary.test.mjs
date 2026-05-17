import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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

test("run-pipeline rewrites stale wiki project sourcePath to canonical --source-path", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-cpb-canonical-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-run-pipeline-source-"));
  const canonical = await realpath(sourcePath);
  const project = "canonical-test";
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  await mkdir(wikiDir, { recursive: true });
  await writeFile(
    path.join(wikiDir, "project.json"),
    JSON.stringify({ name: project, sourcePath: "/stale/noncanonical", custom: "keep-me" }, null, 2),
    "utf8",
  );

  const { stderr } = await execFileAsync(process.execPath, [
    "bridges/run-pipeline.mjs",
    "--project", project,
    "--task", "noop",
    "--source-path", sourcePath,
    "--workflow", "blocked",
  ], { cwd: process.cwd(), env: { ...process.env, CPB_ROOT: cpbRoot } });
  assert.equal(stderr, "");

  const projectJson = JSON.parse(await readFile(path.join(wikiDir, "project.json"), "utf8"));
  assert.equal(projectJson.sourcePath, canonical);
  assert.equal(projectJson.custom, "keep-me");
});
