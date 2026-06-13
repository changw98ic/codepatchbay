import assert from "node:assert/strict";
import { readFile, stat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runDemo } from "../../server/services/setup.js";

test("demo produces all required artifacts and a passing verdict", async () => {
  const result = await runDemo();

  assert.equal(result.ok, true);
  assert.ok(result.project, "result has project name");
  assert.ok(result.tempRoot, "result has tempRoot");
  assert.ok(result.cpbRoot, "result has cpbRoot");
  assert.ok(result.sourcePath, "result has sourcePath");

  // Job completed
  assert.equal(result.job.status, "completed", "job status is completed");
  assert.ok(result.job.jobId, "job has jobId");

  // All six artifacts present
  for (const key of ["plan", "deliverable", "diff", "tests", "verdict", "risk"]) {
    const artifact = result.artifacts[key];
    assert.ok(artifact, `missing artifact: ${key}`);
    assert.ok(artifact.path, `artifact ${key} has path`);
    const info = await stat(artifact.path);
    assert.ok(info.isFile(), `artifact ${key} is a file`);
  }

  // Verdict content is pass
  const verdictContent = await readFile(result.artifacts.verdict.path, "utf8");
  const verdict = JSON.parse(verdictContent);
  assert.equal(verdict.status, "pass");

  // Event log exists and is non-empty
  assert.ok(result.eventLog, "result has eventLog");
  const logInfo = await stat(result.eventLog);
  assert.ok(logInfo.isFile(), "eventLog is a file");
  const logContent = await readFile(result.eventLog, "utf8");
  const logLines = logContent.trim().split("\n").filter(Boolean);
  assert.ok(logLines.length >= 5, `event log has ${logLines.length} entries`);

  // Story has all five entries in correct order
  assert.deepEqual(
    result.story.map((s) => s.name),
    ["plan", "diff", "tests", "verdict", "risk"],
  );

  // Toy repo has the fixed sum.js
  const sumSource = await readFile(path.join(result.sourcePath, "src", "sum.js"), "utf8");
  assert.ok(sumSource.includes("return a + b"), "sum.js was fixed to addition");

  // Cleanup
  await rm(result.tempRoot, { recursive: true, force: true });
});

test("demo runs with custom project name and task", async () => {
  const result = await runDemo({
    project: "custom-demo-project",
    task: "Custom demo task description",
  });

  assert.equal(result.project, "custom-demo-project");
  assert.equal(result.task, "Custom demo task description");
  assert.equal(result.job.status, "completed");

  // Plan mentions the custom task
  const planContent = await readFile(result.artifacts.plan.path, "utf8");
  assert.ok(planContent.includes("Custom demo task description"));

  // Cleanup
  await rm(result.tempRoot, { recursive: true, force: true });
});
