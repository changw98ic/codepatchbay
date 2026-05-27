import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

test("project init route references an existing executable target", async () => {
  const source = await readFile(path.join(repoRoot, "server/routes/projects.js"), "utf8");
  const match = source.match(/\[(?:req\.cpbRoot \+ )?'([^']*init-project\.mjs)'/);
  if (match) {
    const normalized = match[1].replace(/^\//, "");
    assert.equal(await exists(normalized), true, `${normalized} should exist`);
  }
});

test("self-evolve files are removed", async () => {
  const activeFiles = [
    "bridges/self-evolve.mjs",
    "runtime/evolve/self-evolve.js",
    "server/services/evolve-state.js",
  ];
  for (const relativePath of activeFiles) {
    assert.equal(await exists(relativePath), false, `${relativePath} should be removed`);
  }
});

test("evolve route does not reference self-evolve", async () => {
  const routeSource = await readFile(path.join(repoRoot, "server/routes/evolve.js"), "utf8");
  assert.doesNotMatch(routeSource, /self-evolve\.mjs/);
  assert.doesNotMatch(routeSource, /cpb-task["'].["']self-evolve/);
});

test("job artifact route wiring is centralized", async () => {
  const routeFiles = [
    "server/routes/tasks.js",
    "server/routes/events.js",
  ];
  for (const relativePath of routeFiles) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /buildJobArtifactDetail/, `${relativePath} should delegate artifact detail wiring`);
    assert.match(source, /registerJobArtifactDetailRoute/, `${relativePath} should use the shared artifact route helper`);
  }
  assert.equal(await exists("server/routes/job-artifacts.js"), true, "shared artifact route helper should exist");
});
