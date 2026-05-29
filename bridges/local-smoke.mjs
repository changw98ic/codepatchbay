#!/usr/bin/env node
// local-smoke.mjs — repeatable local smoke checks with fake ACP providers.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXECUTOR_ROOT = path.resolve(__dirname, "..");

function fakeClientSource() {
  return `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");

function cleanPath(value) {
  return value.trim().replace(/^["'\`]+|["'\`]+$/g, "").replace(/[.,]$/, "");
}

function firstPath(patterns) {
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) return cleanPath(match[1]);
  }
  return null;
}

async function writeArtifact(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  console.log("fake-acp wrote " + filePath);
}

const planFile = firstPath([
  /^Write the plan to:\\s*(.+)$/m,
]);
const deliverableFile = firstPath([
  /^- Write deliverable ONLY to:\\s*(.+)$/m,
  /^\\d+\\. Write the deliverable to:\\s*(.+)$/m,
  /^Write the deliverable to:\\s*(.+)$/m,
]);
const reviewFile = firstPath([
  /^- ONLY write the review to:\\s*(.+)$/m,
  /^Write the review to:\\s*(.+)$/m,
]);
const verdictFile = firstPath([
  /^- ONLY write the verdict to:\\s*(.+)$/m,
  /^\\d+\\. Write the verdict to:\\s*(.+)$/m,
  /^Write the verdict to:\\s*(.+)$/m,
]);

if (planFile) {
  await writeArtifact(planFile, "# Plan: local fake ACP smoke\\n\\n## Acceptance Criteria\\n- Pipeline creates deliverable, review, and verdict artifacts.\\n");
} else if (deliverableFile) {
  await writeArtifact(deliverableFile, "# Deliverable: local fake ACP smoke\\n\\nPlan-Ref: 001\\n\\nThe fake ACP provider exercised the pipeline artifact path.\\n");
} else if (reviewFile) {
  await writeArtifact(reviewFile, "## Verdict\\nREVIEW: PASS\\n\\n## Summary\\nFake ACP smoke review passed.\\n\\n## Blocking Findings\\nNone.\\n\\n## Non-Blocking Findings\\nNone.\\n");
} else if (verdictFile) {
  await writeArtifact(verdictFile, JSON.stringify({
    status: "pass",
    confidence: 1,
    layers: {
      fast: { status: "pass", detail: "Fake ACP smoke artifacts were present." },
      changed: { status: "not_run", detail: "No production project changes were required." },
      regression: { status: "skipped", detail: "Smoke check intentionally avoids broad regression." },
      acceptance: { status: "pass", detail: "Pipeline reached verifier and wrote a pass verdict." }
    },
    blocking: [],
    diff_summary: "fake smoke only",
    task_goal: "Exercise local init, attach, pipeline, review, verify, and outputs paths.",
    executor_summary: "Fake executor wrote a deliverable artifact.",
    reason: "Fake ACP local smoke passed.",
    fix_scope: []
  }, null, 2) + "\\n");
} else {
  console.error("fake-acp could not find a known artifact path in prompt");
  process.exit(1);
}
`;
}

async function runCommand(command, args, opts = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs || 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const stdout = err.stdout || "";
    const stderr = err.stderr || "";
    const message = [
      `command failed: ${command} ${args.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
      err.message,
    ].filter(Boolean).join("\n");
    throw new Error(message);
  }
}

async function writeFakeClient(tmpRoot) {
  const clientPath = path.join(tmpRoot, "fake-acp-client.mjs");
  await writeFile(clientPath, fakeClientSource(), "utf8");
  await chmod(clientPath, 0o755);
  return clientPath;
}

async function listMarkdownFiles(dir) {
  try {
    return (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function collectArtifacts(cpbRoot, project) {
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const inboxDir = path.join(wikiDir, "inbox");
  const outputsDir = path.join(wikiDir, "outputs");
  return {
    inbox: await listMarkdownFiles(inboxDir),
    outputs: await listMarkdownFiles(outputsDir),
  };
}

function assertArtifacts(artifacts) {
  const required = {
    plan: artifacts.inbox.some((entry) => /^plan-\d+\.md$/.test(entry)),
    deliverable: artifacts.outputs.some((entry) => /^deliverable-\d+\.md$/.test(entry)),
    review: artifacts.outputs.some((entry) => /^review-\d+\.md$/.test(entry)),
    verdict: artifacts.outputs.some((entry) => /^verdict-\d+\.md$/.test(entry)),
  };
  const missing = Object.entries(required).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`fake ACP smoke missing artifacts: ${missing.join(", ")}`);
  }
}

export async function runFakeAcpSmoke({
  executorRoot = DEFAULT_EXECUTOR_ROOT,
  keepTemp = false,
  project = "local-smoke",
} = {}) {
  const root = path.resolve(executorRoot);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-local-smoke-"));
  const cpbRoot = path.join(tmpRoot, "cpb-root");
  const hubRoot = path.join(tmpRoot, "hub");
  const sourcePath = path.join(tmpRoot, "source-project");
  const fakeClient = await writeFakeClient(tmpRoot);

  try {
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "README.md"), "# Local Smoke Project\n", "utf8");
    await writeFile(
      path.join(sourcePath, "package.json"),
      `${JSON.stringify({ name: "cpb-local-smoke-project", private: true }, null, 2)}\n`,
      "utf8",
    );

    const env = {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: root,
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_ROOTS: tmpRoot,
      CPB_ACP_USE_MANAGED_POOL: "0",
      CPB_ACP_CLIENT: fakeClient,
      CPB_USE_WORKTREE: "0",
    };

    const cli = path.join(root, "cli", "cpb.mjs");
    await runCommand(process.execPath, [cli, "init", sourcePath, project], {
      cwd: root,
      env,
    });
    await runCommand(process.execPath, [cli, "attach", sourcePath, project], {
      cwd: root,
      env,
    });
    const { runJobWithServices } = await import("../bridges/engine-bridge.js");
    await runJobWithServices({
      cpbRoot,
      hubRoot,
      project,
      task: "local fake ACP smoke",
      jobId: "job-local-smoke-001",
      workflow: "complex",
      sourcePath,
      maxRetries: 1,
      timeoutMin: 0,
    });

    const artifacts = await collectArtifacts(cpbRoot, project);
    assertArtifacts(artifacts);

    const verdictName = artifacts.outputs.find((entry) => /^verdict-\d+\.md$/.test(entry));
    const verdictPath = path.join(cpbRoot, "wiki", "projects", project, "outputs", verdictName);
    const verdictContent = await readFile(verdictPath, "utf8");
    const verdict = JSON.parse(verdictContent);
    if (verdict.status !== "pass") {
      throw new Error(`fake ACP smoke verdict was not pass: ${verdict.status}`);
    }

    return {
      ok: true,
      name: "fake-acp-smoke",
      project,
      cpbRoot,
      hubRoot,
      sourcePath,
      artifacts,
      keptTemp: keepTemp,
    };
  } finally {
    if (!keepTemp) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const opts = { json: false, keepTemp: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--keep-temp") opts.keepTemp = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: node bridges/local-smoke.mjs [--json] [--keep-temp]

Runs a repeatable local smoke with a fake ACP client. No real provider calls are made.`);
    return 0;
  }
  const result = await runFakeAcpSmoke({ keepTemp: opts.keepTemp });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`PASS fake-acp-smoke project=${result.project}`);
    console.log(`  inbox: ${result.artifacts.inbox.join(", ")}`);
    console.log(`  outputs: ${result.artifacts.outputs.join(", ")}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`FAIL fake-acp-smoke: ${err.message}`);
    process.exitCode = 1;
  });
}
