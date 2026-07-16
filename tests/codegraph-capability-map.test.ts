import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { FailureKind } from "../core/contracts/failure.js";
import { checkCodeGraphReady } from "../server/services/infra.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { readJson, tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function createCodeGraphFixture({ withState = true } = {}) {
  const sourcePath = await tempRoot("cpb-dw01-source");
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await mkdir(path.join(sourcePath, "server", "orchestrator"), { recursive: true });
  await mkdir(path.join(sourcePath, "tests"), { recursive: true });
  await writeFile(path.join(sourcePath, "server", "orchestrator", "scheduler.js"), "export class Scheduler {}\n", "utf8");
  await writeFile(path.join(sourcePath, "tests", "scheduler.test.js"), "import 'node:test';\n", "utf8");
  await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");

  const dbPath = path.join(sourcePath, ".codegraph", "codegraph.db");
  await execFileAsync("sqlite3", [dbPath, `
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      node_count INTEGER DEFAULT 0,
      errors TEXT
    );
    INSERT INTO files VALUES
      ('server/orchestrator/scheduler.js','h1','javascript',26,1,1,3,null),
      ('tests/scheduler.test.js','h2','javascript',19,1,1,1,null),
      ('README.md','h3','markdown',10,1,1,0,null);
  `]);
  if (withState) {
    await writeFile(
      path.join(sourcePath, ".codegraph", "daemon.pid"),
      `${JSON.stringify({ pid: process.pid, version: "test", socketPath: path.join(sourcePath, ".codegraph", "daemon.sock") }, null, 2)}\n`,
      "utf8",
    );
  }
  return sourcePath;
}

test("CodeGraph readiness requires live state, not only an index file", async () => {
  const sourcePath = await createCodeGraphFixture({ withState: false });

  await assert.rejects(
    checkCodeGraphReady({ sourcePath }),
    (err) => {
      const typedErr = err as any;
      assert.equal(typedErr.code, FailureKind.CODEGRAPH_UNAVAILABLE);
      assert.equal(typedErr.details?.reason, "missing_codegraph_state");
      return true;
    },
  );
});

test("registerProject persists high-confidence capability maps from CodeGraph", async () => {
  const hubRoot = await tempRoot("cpb-dw01-hub");
  const sourcePath = await createCodeGraphFixture();

  const project = await registerProject(hubRoot, { id: "flow", sourcePath });
  const stored = (await readJson(path.join(hubRoot, "projects.json"))).projects.flow;

  assert.equal(project.metadata.capabilityMapConfidence, "high");
  assert.equal(stored.metadata.capabilityMapConfidence, "high");
  assert.equal(stored.metadata.codegraphReadiness.available, true);
  assert.equal(stored.metadata.project_capability_map.confidence, "high");
  assert.ok(stored.metadata.project_capability_map.coreModules.includes("server/orchestrator/scheduler.js"));
  assert.ok(stored.metadata.project_capability_map.testSurfaces.includes("tests/scheduler.test.js"));
  assert.equal(stored.metadata.safety_boundary_map.confidence, "high");
  assert.equal(stored.metadata.high_risk_area_map.confidence, "high");
});

test("registerProject can build capability maps from an explicit static CodeGraph index", async () => {
  const hubRoot = await tempRoot("cpb-dw01-static-hub");
  const sourcePath = await createCodeGraphFixture({ withState: false });
  const previous = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";

  try {
    const project = await registerProject(hubRoot, { id: "flow", sourcePath });
    const metadata = project.metadata as Record<string, unknown>;
    const readiness = metadata.codegraphReadiness as Record<string, unknown>;
    const readinessState = readiness.state as Record<string, unknown>;
    const capabilityMap = metadata.project_capability_map as Record<string, unknown>;
    const coreModules = capabilityMap.coreModules;

    assert.equal(metadata.capabilityMapConfidence, "high");
    assert.equal(readinessState.source, "index_only");
    assert.equal(capabilityMap.confidence, "high");
    assert.ok(Array.isArray(coreModules));
    assert.ok(coreModules.includes("server/orchestrator/scheduler.js"));
  } finally {
    if (previous === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previous;
  }
});
