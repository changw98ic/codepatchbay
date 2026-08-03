import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  _checkDoctorNodeForTests,
  _checkExecutorDependenciesForTests,
  deriveReadinessLevels,
} from "../server/services/readiness-checks.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("doctor exposes only the current Node product surface", async () => {
  const source = await readFile(path.join(repoRoot, "server", "services", "readiness-checks.ts"), "utf8");
  const doctor = await readFile(path.join(repoRoot, "cli", "commands", "doctor.ts"), "utf8");
  const combined = `${source}\n${doctor}`;

  assert.doesNotMatch(combined, /codepatchbay-web|build:web|server["', )]+node_modules|cd server && npm install/);
  const level = deriveReadinessLevels([]).levels.find((entry) => entry.id === "tests-build");
  assert.equal(level?.name, "Node tests and build");
  assert.equal(level?.recommendedAction, "Run from executorRoot: npm test && npm run build:node");
});

test("doctor reads Node policy and dependencies from executorRoot package.json", async (t) => {
  const executorRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-doctor-executor-"));
  t.after(async () => rm(executorRoot, { recursive: true, force: true }));
  await mkdir(path.join(executorRoot, "node_modules", "fixture-dependency"), { recursive: true });
  await writeFile(path.join(executorRoot, "node_modules", "fixture-dependency", "package.json"), '{"name":"fixture-dependency","main":"index.js"}\n');
  await writeFile(path.join(executorRoot, "node_modules", "fixture-dependency", "index.js"), "export default true;\n");
  const currentMajor = Number(process.versions.node.split(".")[0]);
  await writeFile(path.join(executorRoot, "package.json"), `${JSON.stringify({
    name: "doctor-fixture",
    engines: { node: `>=${currentMajor}.0.0` },
    dependencies: { "fixture-dependency": "1.0.0" },
  })}\n`);

  const nodeCheck = await _checkDoctorNodeForTests(executorRoot);
  const dependencyCheck = await _checkExecutorDependenciesForTests(executorRoot);
  assert.equal(nodeCheck.status, "ok");
  assert.equal(dependencyCheck.status, "ok");
  assert.equal((nodeCheck.details as { executorRoot: string }).executorRoot, executorRoot);
  assert.equal((dependencyCheck.details as { executorRoot: string }).executorRoot, executorRoot);

  await writeFile(path.join(executorRoot, "package.json"), `${JSON.stringify({
    name: "doctor-fixture",
    engines: { node: `>=${currentMajor}.0.0` },
    dependencies: { "missing-dependency": "1.0.0" },
  })}\n`);
  const missing = await _checkExecutorDependenciesForTests(executorRoot);
  assert.equal(missing.status, "error");
  assert.deepEqual((missing.details as { missing: string[] }).missing, ["missing-dependency"]);
});
