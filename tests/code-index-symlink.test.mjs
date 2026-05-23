import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { refreshProjectCodeIndex, readCompactProjectCodeIndexSummary, indexDirForProject } from "../server/services/project-code-index.js";

async function readIndexFiles(project, hubRoot) {
  const idxDir = indexDirForProject(project, hubRoot);
  const raw = await readFile(path.join(idxDir, "files.json"), "utf8");
  return JSON.parse(raw);
}

describe("code-index symlink dual-path", () => {
  let tmpBase;

  beforeEach(async () => {
    tmpBase = path.join(tmpdir(), `cpb-test-symlink-${Date.now()}`);
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("external symlink produces logical paths without ../", async () => {
    const appDir = path.join(tmpBase, "app");
    const packagesDir = path.join(tmpBase, "packages");
    const sharedDir = path.join(packagesDir, "shared");
    const indexDir = path.join(tmpBase, "index");

    await mkdir(appDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });

    await writeFile(path.join(sharedDir, "utils.js"), "export function add(a, b) { return a + b; }\n");
    await writeFile(path.join(appDir, "main.js"), "import { add } from './shared/utils.js';\n");
    await symlink(sharedDir, path.join(appDir, "shared"));

    const project = { id: "monorepo-test", sourcePath: appDir, projectRuntimeRoot: tmpBase };
    await refreshProjectCodeIndex(project, { hubRoot: tmpBase });

    // Check raw index files for correct logical paths
    const index = await readIndexFiles(project, tmpBase);
    const paths = index.files.map((f) => f.path);

    assert.ok(paths.includes("main.js"), `files should include main.js, got: ${paths}`);
    assert.ok(paths.includes("shared/utils.js"), `files should include shared/utils.js, got: ${paths}`);
    assert.ok(!paths.some((p) => p.startsWith("../")), `no path should start with ../, got: ${paths}`);

    // Summary should show shared/ as top directory, no ../
    const summary = await readCompactProjectCodeIndexSummary(
      { id: project.id, sourcePath: project.sourcePath, projectRuntimeRoot: project.projectRuntimeRoot },
      { hubRoot: tmpBase, maxBytes: 8192 },
    );
    assert.ok(summary.includes("`shared/`"), `summary should show shared/ directory, got:\n${summary}`);
    assert.ok(!summary.includes("../"), `summary must not contain ../`);
  });

  it("cyclic symlink does not cause infinite recursion", async () => {
    const sourceDir = path.join(tmpBase, "src");
    const indexDir = path.join(tmpBase, "index");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });

    await writeFile(path.join(sourceDir, "a.js"), "export const a = 1;\n");
    await symlink(sourceDir, path.join(sourceDir, "loop"));

    const project = { id: "cycle-test", sourcePath: sourceDir, projectRuntimeRoot: tmpBase };
    await refreshProjectCodeIndex(project, { hubRoot: tmpBase });

    const index = await readIndexFiles(project, tmpBase);
    const paths = index.files.map((f) => f.path);

    assert.ok(paths.includes("a.js"), `files should include a.js, got: ${paths}`);
    assert.ok(!paths.some((p) => p.startsWith("loop/")), `cycle should not produce duplicate entries via loop/, got: ${paths}`);
  });

  it("symlink to file produces logical path", async () => {
    const sourceDir = path.join(tmpBase, "src");
    const extDir = path.join(tmpBase, "external");
    const indexDir = path.join(tmpBase, "index");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(extDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });

    await writeFile(path.join(extDir, "helpers.js"), "export const id = (x) => x;\n");
    await symlink(path.join(extDir, "helpers.js"), path.join(sourceDir, "linked-helpers.js"));
    await writeFile(path.join(sourceDir, "app.js"), "console.log('hi');\n");

    const project = { id: "file-symlink-test", sourcePath: sourceDir, projectRuntimeRoot: tmpBase };
    await refreshProjectCodeIndex(project, { hubRoot: tmpBase });

    const index = await readIndexFiles(project, tmpBase);
    const paths = index.files.map((f) => f.path);

    assert.ok(paths.includes("app.js"), `files should include app.js, got: ${paths}`);
    assert.ok(paths.includes("linked-helpers.js"), `files should include linked-helpers.js, got: ${paths}`);
    assert.ok(!paths.some((p) => p.startsWith("../")), `no path should start with ../, got: ${paths}`);
  });
});
