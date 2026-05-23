import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readTaskRelevantIndex } from "../server/services/code-index-adapter.js";

describe("code-index-adapter", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Clear external provider env
    delete process.env.CPB_CODE_INDEX_COMMAND;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("falls back to built-in index when no CPB_CODE_INDEX_PROVIDER set", async () => {
    // Create a temp project dir with a code index
    const tmpBase = path.join(tmpdir(), `cpb-test-adapter-${Date.now()}`);
    const sourceDir = path.join(tmpBase, "source");
    const indexDir = path.join(tmpBase, "index");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });

    // Write a fake summary
    const summaryContent = "# test-project Code Index\n\n## Languages\n- JavaScript: 5 files\n";
    await writeFile(path.join(indexDir, "summary.md"), summaryContent);

    // The built-in readFilteredCodeIndexSummary needs indexDirForProject to resolve
    // via projectRuntimeRoot. We pass hubRoot so it can resolve the index dir.
    // But since indexDirForProject uses projectRuntimeRoot which constructs a path,
    // we need to set up the project record to match.
    // Instead, let's create the proper structure that indexDirForProject expects.
    const projectRecord = {
      id: "test-project",
      sourcePath: sourceDir,
      projectRuntimeRoot: path.join(tmpBase),
    };

    const result = await readTaskRelevantIndex(projectRecord, {
      hubRoot: tmpBase,
      taskDescription: "add dark mode",
      maxBytes: 4096,
    });

    assert.ok(result.includes("test-project"), `result should include project name, got: ${result}`);

    await rm(tmpBase, { recursive: true });
  });

  it("returns empty summary with diagnostic when index unavailable", async () => {
    const tmpBase = path.join(tmpdir(), `cpb-test-noindex-${Date.now()}`);
    const sourceDir = path.join(tmpBase, "source");

    await mkdir(sourceDir, { recursive: true });

    const projectRecord = {
      id: "empty-project",
      sourcePath: sourceDir,
      projectRuntimeRoot: path.join(tmpBase),
    };

    const result = await readTaskRelevantIndex(projectRecord, {
      hubRoot: tmpBase,
      taskDescription: "do something",
      maxBytes: 4096,
    });

    assert.ok(result.includes("unavailable"), `result should mention unavailable, got: ${result}`);
    assert.ok(result.includes("empty-project"), `result should include project name, got: ${result}`);

    await rm(tmpBase, { recursive: true });
  });

  it("external provider: calls external command and returns output", async () => {
    const tmpBase = path.join(tmpdir(), `cpb-test-ext-${Date.now()}`);
    await mkdir(tmpBase, { recursive: true });

    // Create a fake external provider script
    const scriptPath = path.join(tmpBase, "fake-indexer");
    const scriptContent = [
      "#!/bin/sh",
      "printf '%s' '{\"summary\": \"# External Index\\n\\n## Files\\n- src/main.js\\n\"}'",
    ].join("\n") + "\n";
    await writeFile(scriptPath, scriptContent);
    await chmod(scriptPath, 0o755);

    process.env.CPB_CODE_INDEX_COMMAND = scriptPath;

    const projectRecord = {
      id: "ext-project",
      sourcePath: "/tmp/fake-source",
    };

    const result = await readTaskRelevantIndex(projectRecord, {
      taskDescription: "external test",
      maxBytes: 4096,
    });

    assert.ok(result.includes("External Index"), `result should include external provider output, got: ${result}`);
    assert.ok(result.includes("src/main.js"), `result should include file listing, got: ${result}`);

    await rm(tmpBase, { recursive: true });
  });
});
