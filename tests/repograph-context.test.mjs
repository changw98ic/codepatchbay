import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../server/services/hub-registry.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runCpb(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./cpb", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function setupToyProject() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-repograph-"));
  const source = path.join(tmp, "source");
  const hubRoot = path.join(tmp, "hub");
  const cpbRoot = path.join(tmp, "cpb-root");

  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "toy", scripts: { test: "node --test" } }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(source, "src", "index.js"),
    "import { add } from './math.js';\nexport function run() { return add(1, 2); }\n",
    "utf8",
  );
  await writeFile(
    path.join(source, "src", "math.js"),
    "export function add(a, b) { return a + b; }\n",
    "utf8",
  );
  await writeFile(
    path.join(source, "src", "index.test.js"),
    "import { run } from './index.js';\n",
    "utf8",
  );

  await registerProject(hubRoot, { id: "frontend", sourcePath: source });
  return {
    tmp,
    env: { CPB_ROOT: cpbRoot, CPB_HUB_ROOT: hubRoot },
  };
}

test("cpb index graph builds a RepoGraph with import edges", async () => {
  const { tmp, env } = await setupToyProject();
  try {
    const result = await runCpb(["index", "graph", "frontend", "--json"], env);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.status, "ready");
    assert.match(parsed.graphPath, /repo-graph\.json$/);
    assert.ok(parsed.stats.nodeCount >= 4);
    assert.ok(parsed.edges.some((edge) => edge.from === "src/index.js" && edge.to === "src/math.js" && edge.kind === "import"));

    const graph = JSON.parse(await readFile(parsed.graphPath, "utf8"));
    assert.equal(graph.schemaVersion, 1);
    assert.equal(graph.projectId, "frontend");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb index impact returns dependents and dependencies for a target file", async () => {
  const { tmp, env } = await setupToyProject();
  try {
    await runCpb(["index", "graph", "frontend", "--json"], env);
    const result = await runCpb(["index", "impact", "frontend", "src/math.js", "--json"], env);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.target, "src/math.js");
    assert.ok(parsed.impactedFiles.includes("src/math.js"));
    assert.ok(parsed.impactedFiles.includes("src/index.js"));
    assert.ok(parsed.reasons.some((reason) => reason.file === "src/index.js" && reason.kind === "dependent"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb index context-pack writes a graph-informed context pack", async () => {
  const { tmp, env } = await setupToyProject();
  try {
    const result = await runCpb(["index", "context-pack", "frontend", "change math utility", "--json"], env);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.status, "ready");
    assert.match(parsed.contextPack.path, /context-pack-.*\.md$/);
    assert.ok(parsed.contextPack.files.includes("src/math.js"));
    assert.equal(parsed.contextPack.graphPath, parsed.graphPath);

    const pack = await readFile(parsed.contextPack.path, "utf8");
    assert.match(pack, /# Context Pack/);
    assert.match(pack, /RepoGraph/);
    assert.match(pack, /src\/math\.js/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb sdd verify and drift report validate the skeleton against graph context", async () => {
  const { tmp, env } = await setupToyProject();
  try {
    const init = await runCpb(["sdd", "init", "frontend", "--json"], env);
    assert.equal(init.code, 0, init.stderr || init.stdout);

    const verify = await runCpb(["sdd", "verify", "frontend", "--json"], env);
    assert.equal(verify.code, 0, verify.stderr || verify.stdout);
    const verification = JSON.parse(verify.stdout);
    assert.equal(verification.status, "pass");
    assert.equal(verification.artifacts.spec.exists, true);
    assert.equal(verification.trace.valid, true);

    const drift = await runCpb(["sdd", "drift", "frontend", "--task", "change math utility", "--json"], env);
    assert.equal(drift.code, 0, drift.stderr || drift.stdout);
    const report = JSON.parse(drift.stdout);
    assert.ok(["pass", "needs_review"].includes(report.status));
    assert.match(report.reportPath, /sdd-drift-.*\.json$/);
    assert.ok(report.contextPack.files.includes("src/math.js"));
    assert.equal(report.graph.status, "ready");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
