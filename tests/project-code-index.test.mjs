#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  indexDirForProject,
  refreshProjectCodeIndex,
  readProjectCodeIndexStatus,
  readCompactProjectCodeIndexSummary,
} from "../server/services/project-code-index.js";

async function makeFixtureRepo(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "cpb-task", "events"), { recursive: true });
  await mkdir(path.join(root, ".cpb"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "coverage"), { recursive: true });
  await mkdir(path.join(root, "vendor", "lib"), { recursive: true });
  await mkdir(path.join(root, "generated"), { recursive: true });
  await mkdir(path.join(root, ".cache"), { recursive: true });

  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-project",
    scripts: { test: "jest", build: "vite build", lint: "eslint ." },
  }, null, 2));

  await writeFile(path.join(root, "src", "app.js"), `// app entry
export function hello(name) { return "Hello " + name; }
export class App { constructor() { this.ready = true; } }
`);
  await writeFile(path.join(root, "src", "tool.py"), `# tool module
def process(data):
    pass
class Tool:
    def run(self):
        pass
`);
  await writeFile(path.join(root, "src", "lib.rs"), `// rust module
pub fn compute() -> i32 { 42 }
pub struct Engine { power: i32 }
`);

  // Ignored paths
  await writeFile(path.join(root, ".git", "config"), "git config");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module");
  await writeFile(path.join(root, "cpb-task", "events", "job.jsonl"), "event\n");
  await writeFile(path.join(root, ".cpb", "memory.md"), "memory");
  await writeFile(path.join(root, ".env"), "SECRET=abc123");
  await writeFile(path.join(root, "dist", "bundle.js"), "bundle");
  await writeFile(path.join(root, "coverage", "report.json"), "{}");
  await writeFile(path.join(root, "id_rsa"), "private-key");
  await writeFile(path.join(root, "vendor", "lib", "index.js"), "vendor code");
  await writeFile(path.join(root, "generated", "api.ts"), "auto-generated");
  await writeFile(path.join(root, ".cache", "data.json"), "{}");
  await writeFile(path.join(root, "src", "app.min.js"), "minified code");
  await writeFile(path.join(root, "src", "app.min.css"), "minified css");
  await writeFile(path.join(root, "src", "app.bundle.js"), "bundled code");
}

// --- indexDirForProject ---
{
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-dir-"));
  const project = { id: "test-proj", sourcePath: "/tmp/test", projectRuntimeRoot: path.join(hubRoot, "projects", "test-proj") };
  const idxDir = indexDirForProject(project);
  assert.ok(idxDir.endsWith(path.join("test-proj", "index")), `got: ${idxDir}`);

  const projectNoRuntime = { id: "test-proj", sourcePath: "/tmp/test" };
  const idxDir2 = indexDirForProject(projectNoRuntime, hubRoot);
  assert.ok(idxDir2.includes("test-proj"), `fallback includes project id: ${idxDir2}`);
  assert.ok(idxDir2.endsWith(path.join("test-proj", "index")), `fallback ends with index: ${idxDir2}`);

  try {
    indexDirForProject({ id: "orphan" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e.message.includes("orphan"), `error mentions project id: ${e.message}`);
  }

  await rm(hubRoot, { recursive: true, force: true });
}

// --- Full refresh with fixture repo ---
{
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-refresh-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-repo-"));
  const projRuntime = path.join(hubRoot, "projects", "fixture");
  await makeFixtureRepo(repoRoot);

  const project = { id: "fixture", sourcePath: repoRoot, projectRuntimeRoot: projRuntime };

  const statusBefore = await readProjectCodeIndexStatus(project);
  assert.equal(statusBefore.status, "missing");

  const result = await refreshProjectCodeIndex(project);
  assert.equal(result.status, "ready");
  assert.ok(result.fileCount > 0, `fileCount: ${result.fileCount}`);
  assert.ok(result.symbolCount > 0, `symbolCount: ${result.symbolCount}`);
  assert.ok(result.commandCount > 0, `commandCount: ${result.commandCount}`);

  const idxDir = indexDirForProject(project);

  const manifest = JSON.parse(await readFile(path.join(idxDir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.projectId, "fixture");
  assert.ok(manifest.sourcePath);
  assert.ok(manifest.indexRoot);
  assert.ok(manifest.updatedAt);
  assert.ok(manifest.contentHash);
  assert.ok(manifest.stats);
  assert.equal(manifest.stats.fileCount, result.fileCount);

  const files = JSON.parse(await readFile(path.join(idxDir, "files.json"), "utf8"));
  assert.equal(files.schemaVersion, 1);
  assert.ok(Array.isArray(files.files));
  const filePaths = files.files.map((f) => f.path);
  assert.ok(filePaths.includes("package.json"), `includes package.json: ${filePaths}`);
  assert.ok(filePaths.includes("src/app.js"), `includes src/app.js: ${filePaths}`);
  assert.ok(filePaths.includes("src/tool.py"), `includes src/tool.py: ${filePaths}`);
  assert.ok(filePaths.includes("src/lib.rs"), `includes src/lib.rs: ${filePaths}`);

  for (const p of filePaths) {
    assert.ok(!p.includes("node_modules"), `excludes node_modules: ${p}`);
    assert.ok(!p.includes(".git"), `excludes .git: ${p}`);
    assert.ok(!p.includes("cpb-task"), `excludes cpb-task: ${p}`);
    assert.ok(!p.includes(".cpb"), `excludes .cpb: ${p}`);
    assert.ok(!p.startsWith("dist/"), `excludes dist: ${p}`);
    assert.ok(!p.startsWith("coverage/"), `excludes coverage: ${p}`);
  }

  assert.ok(!filePaths.includes(".env"), `excludes .env: ${filePaths}`);
  assert.ok(!filePaths.includes("id_rsa"), `excludes id_rsa: ${filePaths}`);
  assert.ok(!filePaths.some((p) => p.startsWith("vendor/")), `excludes vendor: ${filePaths.filter((p) => p.includes("vendor"))}`);
  assert.ok(!filePaths.some((p) => p.startsWith("generated/")), `excludes generated: ${filePaths.filter((p) => p.includes("generated"))}`);
  assert.ok(!filePaths.some((p) => p.startsWith(".cache/")), `excludes .cache: ${filePaths.filter((p) => p.includes(".cache"))}`);
  assert.ok(!filePaths.some((p) => p.endsWith(".min.js")), `excludes .min.js: ${filePaths.filter((p) => p.endsWith(".min.js"))}`);
  assert.ok(!filePaths.some((p) => p.endsWith(".min.css")), `excludes .min.css: ${filePaths.filter((p) => p.endsWith(".min.css"))}`);
  assert.ok(!filePaths.some((p) => p.endsWith(".bundle.js")), `excludes .bundle.js: ${filePaths.filter((p) => p.endsWith(".bundle.js"))}`);

  const sorted = [...filePaths].sort();
  assert.deepEqual(filePaths, sorted, "files are sorted");

  const symbols = JSON.parse(await readFile(path.join(idxDir, "symbols.json"), "utf8"));
  assert.equal(symbols.schemaVersion, 1);
  assert.ok(Array.isArray(symbols.symbols));
  const symNames = symbols.symbols.map((s) => s.name);
  assert.ok(symNames.includes("hello"), `JS function: ${symNames}`);
  assert.ok(symNames.includes("App"), `JS class: ${symNames}`);
  assert.ok(symNames.includes("process"), `Python def: ${symNames}`);
  assert.ok(symNames.includes("Tool"), `Python class: ${symNames}`);
  assert.ok(symNames.includes("compute"), `Rust fn: ${symNames}`);
  assert.ok(symNames.includes("Engine"), `Rust struct: ${symNames}`);
  for (const sym of symbols.symbols) {
    assert.ok(sym.path, "symbol has path");
    assert.ok(sym.name, "symbol has name");
    assert.ok(sym.kind, "symbol has kind");
    assert.ok(typeof sym.line === "number", "symbol has line");
  }

  const commands = JSON.parse(await readFile(path.join(idxDir, "commands.json"), "utf8"));
  assert.equal(commands.schemaVersion, 1);
  assert.ok(Array.isArray(commands.commands));
  assert.ok(Array.isArray(commands.packageManagers));
  const cmdNames = commands.commands.map((c) => c.name);
  assert.ok(cmdNames.includes("test"), `has test command: ${cmdNames}`);
  assert.ok(cmdNames.includes("build"), `has build command: ${cmdNames}`);
  assert.ok(cmdNames.includes("lint"), `has lint command: ${cmdNames}`);

  const summary = await readFile(path.join(idxDir, "summary.md"), "utf8");
  assert.ok(summary.includes("fixture"), "summary mentions project");
  assert.ok(summary.includes("files") || summary.includes("file"), "summary mentions files");
  assert.ok(summary.includes("symbol") || summary.includes("Symbol"), "summary mentions symbols");

  // Determinism
  const result2 = await refreshProjectCodeIndex(project);
  assert.equal(result2.contentHash, result.contentHash, "contentHash stable across refreshes");

  const files2 = JSON.parse(await readFile(path.join(idxDir, "files.json"), "utf8"));
  const symbols2 = JSON.parse(await readFile(path.join(idxDir, "symbols.json"), "utf8"));
  const commands2 = JSON.parse(await readFile(path.join(idxDir, "commands.json"), "utf8"));
  const summary2 = await readFile(path.join(idxDir, "summary.md"), "utf8");

  assert.deepEqual(files2, files, "files.json stable");
  assert.deepEqual(symbols2, symbols, "symbols.json stable");
  assert.deepEqual(commands2, commands, "commands.json stable");
  assert.equal(summary2, summary, "summary.md stable");

  const statusAfter = await readProjectCodeIndexStatus(project);
  assert.equal(statusAfter.status, "ready");
  assert.equal(statusAfter.fileCount, result.fileCount);

  const compact = await readCompactProjectCodeIndexSummary(project);
  assert.ok(compact.length > 0, "compact summary is non-empty");
  assert.ok(compact.includes("fixture"), "compact summary mentions project");
  assert.ok(compact.length <= 12000, "compact summary within bounds");

  await rm(hubRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
}

// --- Stale state ---
{
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-stale-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-stale-repo-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), '{}');
  const projRuntime = path.join(hubRoot, "projects", "stale-proj");
  const project = { id: "stale-proj", sourcePath: repoRoot, projectRuntimeRoot: projRuntime };

  await refreshProjectCodeIndex(project);

  const idxDir = indexDirForProject(project);
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(idxDir, "files.json"));

  const status = await readProjectCodeIndexStatus(project);
  assert.equal(status.status, "stale", "should be stale when artifact missing");

  await rm(hubRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
}

// --- Error state ---
{
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-error-"));
  const projRuntime = path.join(hubRoot, "projects", "error-proj");
  const project = { id: "error-proj", sourcePath: "/tmp/fake", projectRuntimeRoot: projRuntime };

  const idxDir = indexDirForProject(project);
  await mkdir(idxDir, { recursive: true });
  await writeFile(path.join(idxDir, "manifest.json"), "NOT VALID JSON{{{");

  const status = await readProjectCodeIndexStatus(project);
  assert.equal(status.status, "missing", "corrupt manifest falls back to missing");

  await writeFile(path.join(idxDir, "manifest.json"), '"a string"');
  const status2 = await readProjectCodeIndexStatus(project);
  assert.equal(status2.status, "error", "non-object manifest yields error status");

  await rm(hubRoot, { recursive: true, force: true });
}

// --- Config hashes ---
{
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-cfg-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-cfg-repo-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "cfg-test", scripts: { test: "jest" } }));
  await writeFile(path.join(repoRoot, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  await writeFile(path.join(repoRoot, "src", "index.js"), "export function run() {}\n");

  const projRuntime = path.join(hubRoot, "projects", "cfg-proj");
  const project = { id: "cfg-proj", sourcePath: repoRoot, projectRuntimeRoot: projRuntime };
  await refreshProjectCodeIndex(project);

  const idxDir = indexDirForProject(project);
  const manifest = JSON.parse(await readFile(path.join(idxDir, "manifest.json"), "utf8"));
  assert.ok(manifest.configHashes, "manifest has configHashes");
  assert.ok(manifest.configHashes["package.json"], "configHashes includes package.json");
  assert.ok(manifest.configHashes["tsconfig.json"], "configHashes includes tsconfig.json");

  await rm(hubRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
}

// --- hubRoot fallback ---
{
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-hubfallback-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-hubfallback-repo-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), '{"name":"fallback-test"}');
  await writeFile(path.join(repoRoot, "src", "a.js"), "export function a() {}\n");

  const project = { id: "fallback-proj", sourcePath: repoRoot };

  const statusBefore = await readProjectCodeIndexStatus(project, { hubRoot });
  assert.equal(statusBefore.status, "missing");

  const result = await refreshProjectCodeIndex(project, { hubRoot });
  assert.equal(result.status, "ready");
  assert.ok(result.fileCount > 0);

  const statusAfter = await readProjectCodeIndexStatus(project, { hubRoot });
  assert.equal(statusAfter.status, "ready");

  await rm(hubRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
}

console.log("All project-code-index tests passed.");
