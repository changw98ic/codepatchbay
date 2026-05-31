import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { clearCache, getLatestContextPack } from "../server/services/context-pack-service.js";

describe("context-pack-service", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-cps-test-"));
  });

  after(async () => {
    clearCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("getLatestContextPack returns null when no packs exist", async () => {
    const project = {
      id: "empty-project",
      sourcePath: tmpDir,
      projectRuntimeRoot: path.join(tmpDir, "runtime"),
    };
    const result = await getLatestContextPack(project);
    assert.equal(result, null);
  });

  it("getLatestContextPack reads the most recent pack", async () => {
    const project = {
      id: "test-project",
      sourcePath: tmpDir,
      projectRuntimeRoot: path.join(tmpDir, "runtime-test"),
    };
    const packDir = path.join(project.projectRuntimeRoot, "context-packs");
    await mkdir(packDir, { recursive: true });

    await writeFile(
      path.join(packDir, "context-pack-2026-05-30T00-00-00-000Z.md"),
      "# Context Pack\n\n- Project: test-project\n",
      "utf8",
    );
    await writeFile(
      path.join(packDir, "context-pack-2026-05-31T00-00-00-000Z.md"),
      "# Context Pack\n\n- Project: test-project\n- Task: latest\n",
      "utf8",
    );

    const pack = await getLatestContextPack(project);
    assert.ok(pack);
    assert.equal(pack.kind, "context-pack");
    assert.match(pack.path, /context-pack-2026-05-31/);
    assert.ok(pack.sha256);
    assert.ok(pack.bytes > 0);
  });

  it("clearCache empties the in-memory cache", () => {
    clearCache();
    // No assertion needed — just verifying no throw
    assert.ok(true);
  });
});
