import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  dispatchPhase,
  withPhaseRunnerTestHooksForTests,
} from "../../server/services/phase-runner.js";
import { registerProject } from "../../server/services/hub/hub-registry.js";
import { createJob } from "../../server/services/job/job-store.js";

const suiteRoot = await mkdtemp(path.join(tmpdir(), "cpb-phase-authority-"));
const hubRoot = path.join(suiteRoot, "hub");
process.env.CPB_HUB_ROOT = hubRoot;
let fixtureSequence = 0;

after(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
});

function quoted(value: string) {
  return JSON.stringify(value);
}

async function fixture(
  runnerSource = "process.exitCode = 0;\n",
  {
    bridgeSource = "process.exitCode = 0;\n",
    bridgeFiles = {},
  }: { bridgeSource?: string; bridgeFiles?: Record<string, string> } = {},
) {
  fixtureSequence += 1;
  const project = `phase-authority-${fixtureSequence}`;
  const cpbRoot = path.join(suiteRoot, `source-${fixtureSequence}`);
  const dataRoot = path.join(hubRoot, "projects", project);
  const executorRoot = path.join(cpbRoot, "executor");
  const bridgesDir = path.join(executorRoot, "bridges");
  const jobRunner = path.join(bridgesDir, "job-runner.js");
  const bridgeScript = path.join(bridgesDir, "phase-bridge.js");
  const acpClient = path.join(executorRoot, "server", "services", "acp", "acp-client.js");
  const providerScript = path.join(suiteRoot, `provider-${fixtureSequence}.mjs`);
  await mkdir(bridgesDir, { recursive: true });
  await mkdir(path.dirname(acpClient), { recursive: true });
  await writeFile(path.join(executorRoot, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(jobRunner, runnerSource, "utf8");
  await writeFile(bridgeScript, bridgeSource, "utf8");
  await writeFile(acpClient, "process.exitCode = 0;\n", "utf8");
  await writeFile(providerScript, "#!/usr/bin/env node\nprocess.exitCode = 0;\n", "utf8");
  for (const [fileName, source] of Object.entries(bridgeFiles)) {
    await writeFile(path.join(bridgesDir, fileName), source, "utf8");
  }
  await registerProject(hubRoot, {
    id: project,
    name: project,
    sourcePath: cpbRoot,
    projectRuntimeRoot: dataRoot,
    skipCodeGraphGate: true,
  });
  const job = await createJob(cpbRoot, {
    project,
    task: "phase runner authority regression",
    dataRoot,
    ts: `2026-07-22T00:00:${String(fixtureSequence).padStart(2, "0")}.000Z`,
  });
  return {
    project,
    cpbRoot,
    dataRoot,
    executorRoot,
    bridgesDir,
    jobRunner,
    bridgeScript,
    acpClient,
    providerScript,
    jobId: job.jobId,
  };
}

async function dispatch(state: Awaited<ReturnType<typeof fixture>>, env: NodeJS.ProcessEnv = {}) {
  return dispatchPhase(state.cpbRoot, {
    project: state.project,
    jobId: state.jobId,
    phase: "plan",
    script: "bridges/phase-bridge.js",
    executorRoot: state.executorRoot,
    env: {
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_RUNTIME_ROOT: state.dataRoot,
      CPB_ACP_CODEX_COMMAND: state.providerScript,
      CPB_ACP_CLAUDE_COMMAND: state.providerScript,
      CPB_ACP_CLAUDE_BEDROCK_COMMAND: state.providerScript,
      CPB_ACP_CLAUDE_GLM_COMMAND: state.providerScript,
      CPB_ACP_CLAUDE_MIMO_COMMAND: state.providerScript,
      CPB_ACP_GEMINI_COMMAND: state.providerScript,
      CPB_ACP_FAKE_UNKNOWN_COMMAND: state.providerScript,
      ...env,
    },
  });
}

function aggregateMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const nested = error instanceof AggregateError
    ? error.errors.flatMap((entry) => aggregateMessages(entry))
    : [];
  return [error.message, ...nested];
}

async function doesNotExist(filePath: string) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function mutableNodeExecutable(name: string) {
  const executable = path.join(suiteRoot, name);
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  return executable;
}

test("empty or attacker-controlled PATH cannot replace the trusted Node executable or receive provider secrets", async () => {
  const captureFile = path.join(suiteRoot, "trusted-runner-env.json");
  const fakeNodeMarker = path.join(suiteRoot, "fake-node-called.json");
  const fakeBin = path.join(suiteRoot, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    path.join(fakeBin, "node"),
    `#!/bin/sh\nprintf '%s' \"$OPENAI_API_KEY:$ANTHROPIC_API_KEY:$GEMINI_API_KEY:$AWS_SECRET_ACCESS_KEY\" > ${quoted(fakeNodeMarker)}\nexit 91\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  const state = await fixture(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(captureFile)}, JSON.stringify(process.env));\n`,
  );

  let observedSpawnEnv: NodeJS.ProcessEnv | null = null;
  let observedExecutable = "";
  const hostile = await withPhaseRunnerTestHooksForTests({
    beforeSpawn: (context) => {
      observedSpawnEnv = context.env as NodeJS.ProcessEnv;
      observedExecutable = String(context.executable);
    },
  }, () => dispatch(state, {
    PATH: fakeBin,
    OPENAI_API_KEY: "selected-openai",
    ANTHROPIC_API_KEY: "forbidden-anthropic",
    GEMINI_API_KEY: "forbidden-gemini",
    AWS_SECRET_ACCESS_KEY: "forbidden-aws",
    UNRELATED_SECRET: "forbidden-unrelated",
  }));

  assert.equal(hostile.exitCode, 0, (hostile.error as Error)?.message);
  assert.equal(await doesNotExist(fakeNodeMarker), true, "fake PATH node must never run");
  const childEnv = JSON.parse(await readFile(captureFile, "utf8"));
  assert.equal(observedSpawnEnv?.OPENAI_API_KEY, undefined, "initial spawn must contain no provider credential");
  assert.equal(observedSpawnEnv?.ANTHROPIC_API_KEY, undefined);
  assert.equal(observedSpawnEnv?.GEMINI_API_KEY, undefined);
  assert.equal(observedSpawnEnv?.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, "selected-openai");
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.GEMINI_API_KEY, undefined);
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.UNRELATED_SECRET, undefined);
  for (const envView of [observedSpawnEnv, childEnv]) {
    assert.equal(String(envView?.PATH || "").split(path.delimiter)[0], path.dirname(observedExecutable));
    assert.notEqual(envView?.CPB_EXECUTOR_ROOT, state.executorRoot);
  }

  const emptyPath = await dispatch(state, { PATH: "" });
  assert.equal(emptyPath.exitCode, 0, (emptyPath.error as Error)?.message);
});

test("runner environment exposes exactly one selected provider credential family", async () => {
  const credentialEnv = {
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GEMINI_API_KEY: "gemini-secret",
    MIMO_API_KEY: "mimo-secret",
    GLM_API_KEY: "glm-secret",
  };
  const cases = [
    { agent: "codex", expected: ["OPENAI_API_KEY"] },
    { agent: "claude", expected: ["ANTHROPIC_API_KEY"] },
    { agent: "claude-bedrock", expected: ["AWS_SECRET_ACCESS_KEY"] },
    { agent: "claude-glm", expected: ["GLM_API_KEY"] },
    { agent: "claude-mimo", expected: ["MIMO_API_KEY"] },
    { agent: "gemini", expected: ["GEMINI_API_KEY"] },
    { agent: "fake-unknown", expected: [] },
  ];
  const credentialKeys = Object.keys(credentialEnv);

  for (const entry of cases) {
    const capture = path.join(suiteRoot, `provider-scope-${entry.agent}.json`);
    const state = await fixture(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(capture)}, JSON.stringify(process.env));\n`,
    );
    let initial: NodeJS.ProcessEnv | null = null;
    const result = await withPhaseRunnerTestHooksForTests({
      beforeSpawn: (context) => {
        initial = context.env as NodeJS.ProcessEnv;
      },
    }, () => dispatch(state, {
      ...credentialEnv,
      CPB_OVERRIDE_AGENT: entry.agent,
    }));
    assert.equal(result.exitCode, 0, (result.error as Error)?.message);
    assert.ok(initial);
    const observed = JSON.parse(await readFile(capture, "utf8"));
    for (const key of credentialKeys) {
      assert.equal(initial?.[key], undefined, `${entry.agent} initial spawn must omit ${key}`);
      assert.equal(
        observed[key],
        entry.expected.includes(key) ? credentialEnv[key as keyof typeof credentialEnv] : undefined,
        `${entry.agent} credential scope for ${key}`,
      );
    }
  }

  const variantCapture = path.join(suiteRoot, "provider-scope-variant.json");
  const variantState = await fixture(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(variantCapture)}, JSON.stringify(process.env));\n`,
  );
  let variantInitial: NodeJS.ProcessEnv | null = null;
  const variantResult = await withPhaseRunnerTestHooksForTests({
    beforeSpawn: (context) => { variantInitial = context.env as NodeJS.ProcessEnv; },
  }, () => dispatch(variantState, {
    ...credentialEnv,
    CPB_OVERRIDE_AGENT: "claude",
    CPB_CLAUDE_VARIANT: "glm",
  }));
  assert.equal(variantResult.exitCode, 0, (variantResult.error as Error)?.message);
  assert.equal(variantInitial?.GLM_API_KEY, undefined);
  const variantEnv = JSON.parse(await readFile(variantCapture, "utf8"));
  assert.equal(variantEnv.GLM_API_KEY, "glm-secret");
  assert.equal(variantEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(variantEnv.MIMO_API_KEY, undefined);
});

test("fixed-dir default adapter runs through job-runner, bridge, and ACP client from capsule bytes", async () => {
  const artifactRoot = path.resolve(import.meta.dirname, "..", "..");
  const bridgeName = `phase-capsule-real-adapter-${process.pid}.js`;
  const bridgeScript = path.join(artifactRoot, "bridges", bridgeName);
  const adapter = path.join(suiteRoot, "codex-acp");
  const adapterPredecessor = `${adapter}.predecessor`;
  const executable = await mutableNodeExecutable("real-adapter-bin-node");
  const state = await fixture();
  const adapterMarker = path.join(state.cpbRoot, "real-adapter-original.json");
  const successorMarker = path.join(state.cpbRoot, "real-adapter-successor.json");

  await writeFile(
    bridgeScript,
    [
      "#!/usr/bin/env node",
      'import { runAcp } from "./run-phase.js";',
      'const result = await runAcp("codex", "capsule adapter smoke", process.cwd(), process.env.CPB_EXECUTOR_ROOT);',
      "process.exitCode = result.exitCode;",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(bridgeScript, 0o755);
  await writeFile(
    adapter,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import readline from "node:readline";',
      `writeFileSync(${quoted(adapterMarker)}, JSON.stringify({ secret: process.env.OPENAI_API_KEY || "missing", executable: process.execPath }));`,
      'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      'rl.on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } }, agentInfo: { name: "capsule-fake", version: "1" } } });',
      '  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "capsule-session" } });',
      '  else if (message.method === "session/prompt") { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "capsule-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "capsule-adapter-ok\\n" } } } }); send({ jsonrpc: "2.0", id: message.id, result: null }); }',
      '  else if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: null }); setImmediate(() => process.exit(0)); }',
      '});',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(adapter, 0o755);

  let initialEnv: NodeJS.ProcessEnv | null = null;
  let buildDurationMs = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    executablePath: executable,
    beforeSpawn: (context) => {
      initialEnv = context.env as NodeJS.ProcessEnv;
      buildDurationMs = Number(context.capsuleBuildDurationMs);
    },
    spawnChild: ((command, args, options) => {
      renameSync(adapter, adapterPredecessor);
      writeFileSync(
        adapter,
        `#!/bin/sh\nprintf '%s' "$OPENAI_API_KEY" > ${quoted(successorMarker)}\nexit 93\n`,
        { encoding: "utf8", mode: 0o755 },
      );
      return spawn(command, args, options);
    }) as typeof spawn,
  }, () => dispatchPhase(state.cpbRoot, {
    project: state.project,
    jobId: state.jobId,
    phase: "plan",
    script: `bridges/${bridgeName}`,
    executorRoot: artifactRoot,
    env: {
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_RUNTIME_ROOT: state.dataRoot,
      PATH: path.join(suiteRoot, "hostile-provider-path"),
      OPENAI_API_KEY: "real-adapter-secret",
    },
  }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.equal(initialEnv?.OPENAI_API_KEY, undefined);
  assert.ok(buildDurationMs > 0 && buildDurationMs < 120_000, `capsule build cost ${buildDurationMs}ms`);
  const captured = JSON.parse(await readFile(adapterMarker, "utf8"));
  assert.equal(captured.secret, "real-adapter-secret");
  assert.notEqual(path.resolve(captured.executable), path.resolve(executable));
  assert.equal(await doesNotExist(successorMarker), true);
  await rm(bridgeScript, { force: true });
});

test("default npm adapter package and native provider executable are mapped into the capsule", async () => {
  const prefix = path.join(suiteRoot, `npm-provider-${fixtureSequence + 1}`);
  const binDir = path.join(prefix, "bin");
  const packageRoot = path.join(prefix, "lib", "node_modules", "capsule-codex-acp");
  const adapterEntry = path.join(packageRoot, "dist", "index.js");
  const nativeEntry = path.join(
    packageRoot,
    "node_modules",
    "@openai",
    "codex-test",
    "vendor",
    "test-platform",
    "bin",
    "codex",
  );
  const executable = path.join(binDir, "node");
  const commandLink = path.join(binDir, "codex-acp");
  const capture = path.join(suiteRoot, "npm-provider-env.json");
  await mkdir(path.dirname(adapterEntry), { recursive: true });
  await mkdir(path.dirname(nativeEntry), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  await writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(adapterEntry, "#!/usr/bin/env node\nprocess.exitCode = 0;\n", { encoding: "utf8", mode: 0o755 });
  await copyFile("/usr/bin/true", nativeEntry);
  await chmod(nativeEntry, 0o755);
  await symlink(path.relative(binDir, adapterEntry), commandLink);
  const state = await fixture(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(capture)}, JSON.stringify(process.env));\n`,
  );

  let buildDurationMs = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    executablePath: executable,
    beforeSpawn: (context) => {
      buildDurationMs = Number(context.capsuleBuildDurationMs);
    },
  }, () => dispatchPhase(state.cpbRoot, {
    project: state.project,
    jobId: state.jobId,
    phase: "plan",
    script: "bridges/phase-bridge.js",
    executorRoot: state.executorRoot,
    env: {
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_RUNTIME_ROOT: state.dataRoot,
      PATH: path.join(suiteRoot, "hostile-npm-path"),
      OPENAI_API_KEY: "npm-provider-secret",
    },
  }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.ok(buildDurationMs > 0 && buildDurationMs < 120_000, `capsule build cost ${buildDurationMs}ms`);
  const env = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(env.OPENAI_API_KEY, "npm-provider-secret");
  assert.equal(env.CPB_ACP_CODEX_COMMAND, path.join(env.PATH.split(path.delimiter)[0], "node"));
  const args = JSON.parse(env.CPB_ACP_CODEX_ARGS);
  assert.match(args[0], /cpb-phase-launch-.*provider\/package\/dist\/index\.js$/);
  assert.match(env.CPB_CAPSULE_CODEX_PATH, /cpb-phase-launch-.*provider\/package\/node_modules\/@openai\/codex-test\/.*\/bin\/codex$/);
  assert.equal(env.CPB_ACP_CLIENT.startsWith(env.CPB_EXECUTOR_ROOT), true);
});

test("job-runner replacement inside the spawn call executes only capsule bytes and gives the successor no secret", async () => {
  const originalMarker = path.join(suiteRoot, "job-runner-original.json");
  const successorMarker = path.join(suiteRoot, "job-runner-successor.json");
  const state = await fixture(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(originalMarker)}, process.env.OPENAI_API_KEY || "missing");\n`,
  );
  let spawnCalls = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: ((command, args, options) => {
      spawnCalls += 1;
      renameSync(state.jobRunner, `${state.jobRunner}.predecessor`);
      writeFileSync(
        state.jobRunner,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(successorMarker)}, process.env.OPENAI_API_KEY || "missing");\n`,
        "utf8",
      );
      const child = spawn(command, args, options);
      const blockedUntil = Date.now() + 500;
      while (Date.now() < blockedUntil) {}
      return child;
    }) as typeof spawn,
  }, () => dispatch(state, { OPENAI_API_KEY: "release-secret" }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.equal(spawnCalls, 1);
  assert.equal(await readFile(originalMarker, "utf8"), "release-secret");
  assert.equal(await doesNotExist(successorMarker), true);
});

test("capsule target replacement before bootstrap readiness receives no credential and executes no successor", async () => {
  const originalMarker = path.join(suiteRoot, "capsule-ready-original.json");
  const successorMarker = path.join(suiteRoot, "capsule-ready-successor.json");
  const state = await fixture(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(originalMarker)}, process.env.OPENAI_API_KEY || "missing");\n`,
  );
  let capsuleRoot = "";
  let capsuleJobRunner = "";
  let initialEnv: NodeJS.ProcessEnv | null = null;
  const result = await withPhaseRunnerTestHooksForTests({
    beforeSpawn: (context) => {
      capsuleRoot = path.dirname(String(context.executorRoot));
      capsuleJobRunner = String(context.jobRunner);
      initialEnv = context.env as NodeJS.ProcessEnv;
    },
    spawnChild: ((command, args, options) => {
      chmodSync(path.dirname(capsuleJobRunner), 0o700);
      // The synchronous operations place the successor before the child can
      // validate and signal readiness on its private fd 3.
      renameSync(capsuleJobRunner, `${capsuleJobRunner}.predecessor`);
      writeFileSync(
        capsuleJobRunner,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(successorMarker)}, process.env.OPENAI_API_KEY || "missing");\n`,
        "utf8",
      );
      return spawn(command, args, options);
    }) as typeof spawn,
  }, () => dispatch(state, { OPENAI_API_KEY: "must-not-be-delivered" }));

  assert.equal(result.exitCode, 1);
  assert.equal(initialEnv?.OPENAI_API_KEY, undefined);
  assert.equal(await doesNotExist(originalMarker), true);
  assert.equal(await doesNotExist(successorMarker), true);
  assert.match(aggregateMessages(result.error).join("\n"), /bootstrap|capsule|digest|generation/i);
  if (capsuleRoot) {
    assert.match(path.basename(capsuleRoot), /^cpb-phase-launch-/);
    await rm(capsuleRoot, { recursive: true, force: true });
  }
});

test("phase bridge and imported executor closure replacements cannot execute or receive credentials", async () => {
  const bridgeOriginal = path.join(suiteRoot, "bridge-original.json");
  const bridgeSuccessor = path.join(suiteRoot, "bridge-successor.json");
  const helperOriginal = path.join(suiteRoot, "helper-original.json");
  const helperSuccessor = path.join(suiteRoot, "helper-successor.json");
  const runnerSource = [
    'import "./runner-helper.js";',
    'import { spawnSync } from "node:child_process";',
    'const index = process.argv.indexOf("--script");',
    'const result = spawnSync(process.execPath, [process.argv[index + 1]], { env: process.env, stdio: "inherit" });',
    'process.exitCode = result.status ?? 1;',
    "",
  ].join("\n");
  const state = await fixture(runnerSource, {
    bridgeSource: `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(bridgeOriginal)}, process.env.OPENAI_API_KEY || "missing");\n`,
    bridgeFiles: {
      "runner-helper.js": `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(helperOriginal)}, process.env.OPENAI_API_KEY || "missing");\n`,
    },
  });
  const helper = path.join(state.bridgesDir, "runner-helper.js");
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: ((command, args, options) => {
      renameSync(state.bridgeScript, `${state.bridgeScript}.predecessor`);
      writeFileSync(
        state.bridgeScript,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(bridgeSuccessor)}, process.env.OPENAI_API_KEY || "missing");\n`,
        "utf8",
      );
      renameSync(helper, `${helper}.predecessor`);
      writeFileSync(
        helper,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(helperSuccessor)}, process.env.OPENAI_API_KEY || "missing");\n`,
        "utf8",
      );
      return spawn(command, args, options);
    }) as typeof spawn,
  }, () => dispatch(state, { OPENAI_API_KEY: "closure-secret" }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.equal(await readFile(bridgeOriginal, "utf8"), "closure-secret");
  assert.equal(await readFile(helperOriginal, "utf8"), "closure-secret");
  assert.equal(await doesNotExist(bridgeSuccessor), true);
  assert.equal(await doesNotExist(helperSuccessor), true);
});

test("whole executor-root successor cannot cross the capsule launch boundary", async () => {
  const originalMarker = path.join(suiteRoot, "executor-original.json");
  const successorMarker = path.join(suiteRoot, "executor-successor.json");
  const state = await fixture(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(originalMarker)}, process.env.OPENAI_API_KEY || "missing");\n`,
  );
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: ((command, args, options) => {
      renameSync(state.executorRoot, `${state.executorRoot}.predecessor`);
      mkdirSync(state.bridgesDir, { recursive: true });
      writeFileSync(path.join(state.executorRoot, "package.json"), '{"type":"module"}\n', "utf8");
      writeFileSync(
        state.jobRunner,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(successorMarker)}, process.env.OPENAI_API_KEY || "missing");\n`,
        "utf8",
      );
      writeFileSync(state.bridgeScript, "process.exitCode = 0;\n", "utf8");
      return spawn(command, args, options);
    }) as typeof spawn,
  }, () => dispatch(state, { OPENAI_API_KEY: "executor-secret" }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.equal(await readFile(originalMarker, "utf8"), "executor-secret");
  assert.equal(await doesNotExist(successorMarker), true);
});

test("capsule authority corruption still fails closed before spawn", async () => {
  const state = await fixture();
  let spawnCalls = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    beforeSpawn: (context) => {
      const authorities = context.authorities as Array<{ label: string; generation: { ctimeMs: number } }>;
      const authority = authorities.find((entry) => entry.label === "Node executable parent");
      assert.ok(authority);
      authority.generation.ctimeMs = -1;
    },
    spawnChild: (() => {
      spawnCalls += 1;
      throw new Error("spawn must not be reached");
    }) as never,
  }, () => dispatch(state, { OPENAI_API_KEY: "must-not-escape" }));

  assert.equal(result.exitCode, 1);
  assert.equal(spawnCalls, 0);
  assert.match((result.error as Error).message, /changed after its authority was bound/);
});

test("a source job-runner symlink is rejected before capsule creation and spawn", async () => {
  const state = await fixture();
  let spawnCalls = 0;
  const predecessor = `${state.jobRunner}.predecessor`;
  await rename(state.jobRunner, predecessor);
  await symlink(predecessor, state.jobRunner);
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: (() => {
      spawnCalls += 1;
      throw new Error("spawn must not be reached");
    }) as never,
  }, () => dispatch(state));

  assert.equal(result.exitCode, 1);
  assert.equal(spawnCalls, 0);
  assert.match((result.error as Error).message, /non-symlink|symlink or special/);
});

test("an absolute bridge outside the bound executor cannot execute or capture secrets", async () => {
  const state = await fixture();
  const marker = path.join(suiteRoot, "outside-bridge-captured-secret");
  const outside = path.join(state.cpbRoot, "outside-bridge.js");
  await writeFile(
    outside,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${quoted(marker)}, process.env.OPENAI_API_KEY || "missing");\n`,
    "utf8",
  );
  let spawnCalls = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: (() => {
      spawnCalls += 1;
      throw new Error("spawn must not be reached");
    }) as never,
  }, () => dispatchPhase(state.cpbRoot, {
    project: state.project,
    jobId: state.jobId,
    phase: "plan",
    script: outside,
    executorRoot: state.executorRoot,
    env: {
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_RUNTIME_ROOT: state.dataRoot,
      OPENAI_API_KEY: "must-not-escape",
    },
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(spawnCalls, 0);
  assert.equal(await doesNotExist(marker), true);
  assert.match((result.error as Error).message, /phase bridge script escapes/);
});

test("a symlink phase bridge is rejected before any runner can execute it", async () => {
  const state = await fixture();
  const predecessor = `${state.bridgeScript}.predecessor`;
  await rename(state.bridgeScript, predecessor);
  await symlink(predecessor, state.bridgeScript);
  let spawnCalls = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: (() => {
      spawnCalls += 1;
      throw new Error("spawn must not be reached");
    }) as never,
  }, () => dispatch(state, { OPENAI_API_KEY: "must-not-escape" }));

  assert.equal(result.exitCode, 1);
  assert.equal(spawnCalls, 0);
  assert.match((result.error as Error).message, /canonical non-symlink path/);
});

test("in-place mutation of the source Node executable cannot execute or receive credentials", async () => {
  const sourceExecutable = await mutableNodeExecutable("mutable-node-in-place");
  const successorMarker = path.join(suiteRoot, "mutable-node-in-place-successor");
  const state = await fixture();
  let distinctInode = false;
  const result = await withPhaseRunnerTestHooksForTests({
    executablePath: sourceExecutable,
    beforeSpawn: async (context) => {
      const [sourceInfo, capsuleInfo] = await Promise.all([
        stat(sourceExecutable),
        stat(String(context.executable)),
      ]);
      distinctInode = sourceInfo.dev !== capsuleInfo.dev || sourceInfo.ino !== capsuleInfo.ino;
    },
    spawnChild: ((command, args, options) => {
      writeFileSync(
        sourceExecutable,
        `#!/bin/sh\nprintf '%s' "$OPENAI_API_KEY" > ${quoted(successorMarker)}\nexit 91\n`,
        "utf8",
      );
      return spawn(command, args, options);
    }) as typeof spawn,
  }, () => dispatch(state, { OPENAI_API_KEY: "node-in-place-secret" }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.equal(distinctInode, true);
  assert.equal(await doesNotExist(successorMarker), true);
});

test("rename-successor replacement of the source Node executable cannot execute or receive credentials", async () => {
  const sourceExecutable = await mutableNodeExecutable("mutable-node-rename");
  const successorMarker = path.join(suiteRoot, "mutable-node-rename-successor");
  const state = await fixture();
  const result = await withPhaseRunnerTestHooksForTests({
    executablePath: sourceExecutable,
    spawnChild: ((command, args, options) => {
      renameSync(sourceExecutable, `${sourceExecutable}.predecessor`);
      writeFileSync(
        sourceExecutable,
        `#!/bin/sh\nprintf '%s' "$OPENAI_API_KEY" > ${quoted(successorMarker)}\nexit 92\n`,
        { encoding: "utf8", mode: 0o755 },
      );
      return spawn(command, args, options);
    }) as typeof spawn,
  }, () => dispatch(state, { OPENAI_API_KEY: "node-rename-secret" }));

  assert.equal(result.exitCode, 0, (result.error as Error)?.message);
  assert.equal(await doesNotExist(successorMarker), true);
});

test("copied Node launch/RPATH preflight fails before the credentialed bootstrap spawn", async () => {
  const invalidNode = path.join(suiteRoot, "invalid-node-runtime");
  await writeFile(invalidNode, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  await chmod(invalidNode, 0o755);
  const state = await fixture();
  let bootstrapSpawns = 0;
  const result = await withPhaseRunnerTestHooksForTests({
    executablePath: invalidNode,
    spawnChild: (() => {
      bootstrapSpawns += 1;
      throw new Error("credentialed bootstrap spawn must not be reached");
    }) as never,
  }, () => dispatch(state, { OPENAI_API_KEY: "preflight-secret" }));

  assert.equal(result.exitCode, 1);
  assert.equal(bootstrapSpawns, 0);
  assert.match(aggregateMessages(result.error).join("\n"), /launch\/RPATH preflight/);
  assert.equal((result.error as NodeJS.ErrnoException).code, "PHASE_RUNNER_NODE_PREFLIGHT_FAILED");
});

test("spawn and authority cleanup failures are returned as one aggregate error", async () => {
  const state = await fixture();
  let injectedCloseFailure = false;
  const result = await withPhaseRunnerTestHooksForTests({
    spawnChild: (() => {
      throw new Error("injected spawn failure");
    }) as never,
    afterAuthorityClose: ({ label }) => {
      if (!injectedCloseFailure && label === "Node executable") {
        injectedCloseFailure = true;
        throw new Error("injected close failure");
      }
    },
  }, () => dispatch(state));

  assert.equal(result.exitCode, 1);
  assert.ok(result.error instanceof AggregateError);
  const messages = aggregateMessages(result.error);
  assert.ok(messages.some((message) => message.includes("injected spawn failure")));
  assert.ok(messages.some((message) => message.includes("injected close failure")));
});

test("capsule cleanup preserves a replacement generation and reports the recovery path", async () => {
  const state = await fixture();
  const successorExecutionMarker = path.join(suiteRoot, "cleanup-successor-executed");
  let capsuleRoot = "";
  let successorPath = "";
  let injected = false;
  const result = await withPhaseRunnerTestHooksForTests({
    afterAuthorityClose: async ({ label, path: authorityPath }) => {
      if (injected || label !== "Node executable") return;
      injected = true;
      successorPath = authorityPath;
      capsuleRoot = path.dirname(path.dirname(authorityPath));
      await chmod(path.dirname(authorityPath), 0o700);
      await rename(authorityPath, `${authorityPath}.predecessor`);
      await writeFile(
        authorityPath,
        `#!/bin/sh\nprintf executed > ${quoted(successorExecutionMarker)}\nexit 93\n`,
        { encoding: "utf8", mode: 0o700 },
      );
    },
  }, () => dispatch(state, { OPENAI_API_KEY: "cleanup-secret" }));

  assert.equal(result.exitCode, 1);
  assert.ok(result.error instanceof AggregateError);
  assert.equal(await doesNotExist(successorPath), false, "cleanup must preserve an unowned successor inode");
  assert.equal(await doesNotExist(successorExecutionMarker), true, "cleanup successor must never execute");
  assert.ok(aggregateMessages(result.error).some((message) => message.includes(path.dirname(successorPath))));
  await rm(capsuleRoot, { recursive: true, force: true });
});

test("partial capsule build faults clean every registered generation", async () => {
  for (const faultPoint of [
    "after-root-registered",
    "after-directory-registered",
    "after-file-registered",
    "after-file-copied",
    "after-manifest-copied",
  ]) {
    const state = await fixture();
    let capsuleRoot = "";
    let injected = false;
    const result = await withPhaseRunnerTestHooksForTests({
      capsuleFault: (point, context) => {
        const expectedPoint = faultPoint === "after-manifest-copied" ? "after-file-copied" : faultPoint;
        if (injected || point !== expectedPoint) return;
        if (faultPoint === "after-manifest-copied" && context.label !== "launch manifest") return;
        injected = true;
        capsuleRoot = String(context.root);
        throw new Error(`injected capsule build fault: ${faultPoint}`);
      },
    }, () => dispatch(state));
    assert.equal(result.exitCode, 1);
    assert.equal(injected, true, faultPoint);
    assert.match(aggregateMessages(result.error).join("\n"), new RegExp(faultPoint));
    assert.equal(await doesNotExist(capsuleRoot), true, `${faultPoint} must not leak its capsule root`);
  }
});

test("capsule entry, byte, depth, and build-time bounds fail closed and clean partial roots", async () => {
  const cases = [
    { label: "entries", limits: { maxEntries: 1 } },
    { label: "bytes", limits: { maxBytes: 1 } },
    { label: "depth", limits: { maxDepth: 0 } },
    { label: "time", limits: { timeoutMs: 1 }, delayAtRoot: true },
  ];
  for (const entry of cases) {
    const state = await fixture();
    let capsuleRoot = "";
    const result = await withPhaseRunnerTestHooksForTests({
      capsuleLimits: entry.limits,
      capsuleFault: async (point, context) => {
        capsuleRoot ||= String(context.root);
        if (entry.delayAtRoot && point === "after-root-registered") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    }, () => dispatch(state));
    assert.equal(result.exitCode, 1, entry.label);
    assert.match(aggregateMessages(result.error).join("\n"), /capsule (?:exceeds|build timed out)/i);
    assert.equal(await doesNotExist(capsuleRoot), true, `${entry.label} limit must clean its partial capsule`);
  }
});

test("relative bridge paths cannot escape the executor root", async () => {
  const state = await fixture();
  const result = await dispatchPhase(state.cpbRoot, {
      project: state.project,
      jobId: state.jobId,
      phase: "plan",
      script: "../../outside.js",
      executorRoot: state.executorRoot,
      env: { CPB_HUB_ROOT: hubRoot, CPB_PROJECT_RUNTIME_ROOT: state.dataRoot },
    });
  assert.equal(result.exitCode, 1);
  assert.match((result.error as Error).message, /phase bridge script/);
});
