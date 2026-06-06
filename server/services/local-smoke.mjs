#!/usr/bin/env node
// local-smoke.mjs — repeatable local smoke checks with fake ACP providers.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXECUTOR_ROOT = path.resolve(__dirname, "..", "..");

const PLAN_PROMPT_RE = "software planning agent";
const EXECUTE_PROMPT_RE = "software execution agent";
const REVIEW_PROMPT_RE = "code review agent";
const VERIFY_PROMPT_RE = "software verification agent";

function jsonEnvelope(data) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
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

async function withProcessEnv(env, fn) {
  const previous = new Map();
  for (const key of Object.keys(env)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeTestAgentScenario(tmpRoot) {
  const scenarioPath = path.join(tmpRoot, "test-acp-scenario.json");
  await writeFile(
    scenarioPath,
    `${JSON.stringify({
      responses: [
        {
          name: "plan",
          matchRegex: PLAN_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            planMarkdown: "## Analysis\n- Exercise CPB's full fake ACP chain through the registered fake-acp agent.\n\n## Files to modify\n- README.md (smoke target only)\n\n## Implementation Steps\n1. Use the deterministic fake ACP provider.\n2. Return JSON envelopes for plan, execute, review, and verify phases.\n3. Let CPB persist every phase artifact.\n\n## Testing\n- Confirm CPB creates plan, deliverable, review, and verdict artifacts.\n\n## Risks\n- This smoke proves orchestration and ACP transport, not real provider quality.",
          }),
        },
        {
          name: "execute",
          matchRegex: EXECUTE_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            summary: "Fake ACP executed the smoke path and intentionally left README.md unchanged.",
            tests: ["server/services/local-smoke.mjs: fake-acp full-chain smoke reached execute"],
            risks: ["No production source changes are expected in this smoke."],
          }),
        },
        {
          name: "review",
          matchRegex: REVIEW_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            verdict: "approved",
            summary: "Fake ACP smoke review approved the deterministic deliverable.",
            comments: [],
          }),
        },
        {
          name: "verify",
          matchRegex: VERIFY_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "Fake ACP local smoke passed.",
            details: "The registered fake-acp agent completed plan, execute, review, and verify contracts through CPB.",
            confidence: 1,
          }),
        },
      ],
      default: {
        output: "fake-acp no matching artifact path",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return scenarioPath;
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

async function collectTranscriptEvents(transcriptFile) {
  try {
    const raw = await readFile(transcriptFile, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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
  codegraph = false,
} = {}) {
  const root = path.resolve(executorRoot);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-local-smoke-"));
  const cpbRoot = path.join(tmpRoot, "cpb-root");
  const hubRoot = path.join(tmpRoot, "hub");
  const sourcePath = path.join(tmpRoot, "source-project");
  const scenarioFile = await writeTestAgentScenario(tmpRoot);
  const transcriptFile = path.join(tmpRoot, "test-acp-transcript.jsonl");
  const testAgentPath = path.join(root, "server", "services", "test-acp-agent.mjs");
  const testAgentArgs = JSON.stringify([testAgentPath, "--scenario-file", scenarioFile, "--transcript-file", transcriptFile]);

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
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_TIMEOUT_MS: "30000",
      CPB_ACP_PHASE_TIMEOUT_MS: "30000",
      CPB_ACP_POOL_TIMEOUT_MS: "30000",
      CPB_PHASE_RETRY_MAX: "0",
      CPB_PHASE_CORRECTION_MAX: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: testAgentArgs,
      CPB_USE_WORKTREE: "0",
      ...(codegraph ? {} : { CPB_CODEGRAPH_ENABLED: "0" }),
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
    const { writeProjectAgents } = await import("./agent-config.js");
    await writeProjectAgents(cpbRoot, project, {
      default: "fake-acp",
      phases: {
        plan: "fake-acp",
        execute: "fake-acp",
        review: "fake-acp",
        verify: "fake-acp",
      },
    });
    await withProcessEnv(env, async () => {
      const { runJobWithServices } = await import("./engine-runner.js");
      return runJobWithServices({
        cpbRoot,
        hubRoot,
        project,
        task: "local fake ACP smoke",
        jobId: "job-local-smoke-001",
        workflow: "complex",
        sourcePath,
        maxRetries: 1,
        agents: {
          planner: "fake-acp",
          executor: "fake-acp",
          reviewer: "fake-acp",
          verifier: "fake-acp",
        },
        env,
      });
    });

    const artifacts = await collectArtifacts(cpbRoot, project);
    assertArtifacts(artifacts);

    const verdictName = artifacts.outputs.find((entry) => /^verdict-\d+\.md$/.test(entry));
    const verdictPath = path.join(cpbRoot, "wiki", "projects", project, "outputs", verdictName);
    const verdictContent = await readFile(verdictPath, "utf8");
    if (!/^## Status\s+PASS\b/m.test(verdictContent)) {
      throw new Error(`fake ACP smoke verdict was not pass: ${verdictContent.slice(0, 200)}`);
    }

    const transcriptEvents = await collectTranscriptEvents(transcriptFile);
    if (codegraph) {
      const codegraphSession = transcriptEvents.find((event) =>
        event.event === "session/new" &&
        Array.isArray(event.mcpServers) &&
        event.mcpServers.some((server) => server?.name === "codegraph" && server?.type === "sse" && server?.url)
      );
      if (!codegraphSession) {
        throw new Error("fake ACP smoke did not receive codegraph MCP server in session/new");
      }
    }

    return {
      ok: true,
      name: "fake-acp-smoke",
      project,
      cpbRoot,
      hubRoot,
      sourcePath,
      artifacts,
      codegraph: {
        enabled: Boolean(codegraph),
        sessionsWithMcp: transcriptEvents.filter((event) => event.event === "session/new" && event.mcpServers?.length > 0).length,
      },
      keptTemp: keepTemp,
    };
  } finally {
    if (!keepTemp) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const opts = { json: false, keepTemp: false, codegraph: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--keep-temp") opts.keepTemp = true;
    else if (arg === "--codegraph") opts.codegraph = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: node server/services/local-smoke.mjs [--json] [--keep-temp] [--codegraph]

Runs a repeatable local smoke with a fake ACP client. No real provider calls are made.`);
    return 0;
  }
  const result = await runFakeAcpSmoke({ keepTemp: opts.keepTemp, codegraph: opts.codegraph });
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
