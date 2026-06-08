import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { FailureKind } from "../core/contracts/failure.js";
import { checkCodeGraphReady } from "../server/services/codegraph-readiness.js";
import { registerProject } from "../server/services/hub-registry.js";
import { snapshotForJob } from "../server/services/index-freshness.js";
import { readJson, tempRoot } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

async function createCodeGraphFixture({ withState = true } = {}) {
  const sourcePath = await tempRoot("cpb-dw01-source");
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await mkdir(path.join(sourcePath, "server", "orchestrator"), { recursive: true });
  await mkdir(path.join(sourcePath, "tests"), { recursive: true });
  await writeFile(path.join(sourcePath, "server", "orchestrator", "scheduler.js"), "export class Scheduler {}\n", "utf8");
  await writeFile(path.join(sourcePath, "tests", "scheduler.test.mjs"), "import 'node:test';\n", "utf8");
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
      ('tests/scheduler.test.mjs','h2','javascript',19,1,1,1,null),
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

test("missing sourcePath blocks queue entry with codegraph_unavailable", () => {
  assert.equal(FailureKind.CODEGRAPH_UNAVAILABLE, "codegraph_unavailable");
  assert.equal(typeof FailureKind.INDEX_UNAVAILABLE, "undefined");
});

test("snapshotForJob uses codegraph_unavailable fallback when result unavailable", () => {
  const snap = snapshotForJob(null);
  assert.equal(snap.indexFreshness.available, false);
  assert.deepEqual(snap.indexFreshness.dirtyReasons, ["codegraph_unavailable"]);
});

test("snapshotForJob returns correct data when result is available", () => {
  const snap = snapshotForJob({
    available: true,
    indexSnapshotId: "snap-1",
    sourceFingerprint: "fp-1",
    indexDirty: false,
    indexStale: false,
    worktreeDirty: false,
    dirtyReasons: [],
  });
  assert.equal(snap.indexFreshness.available, true);
  assert.equal(snap.indexSnapshotId, "snap-1");
  assert.equal(snap.sourceFingerprint, "fp-1");
});

test("CodeGraph readiness requires live state, not only an index file", async () => {
  const sourcePath = await createCodeGraphFixture({ withState: false });

  await assert.rejects(
    checkCodeGraphReady({ sourcePath }),
    (err) => {
      assert.equal(err.code, FailureKind.CODEGRAPH_UNAVAILABLE);
      assert.equal(err.details?.reason, "missing_codegraph_state");
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
  assert.ok(stored.metadata.project_capability_map.testSurfaces.includes("tests/scheduler.test.mjs"));
  assert.equal(stored.metadata.safety_boundary_map.confidence, "high");
  assert.equal(stored.metadata.high_risk_area_map.confidence, "high");
});
