import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createAgentHome } from "../core/agents/isolation.js";
import { AcpClient, resolveAcpAuditFile } from "../server/services/acp/acp-client.js";
import { tempRoot } from "./helpers.js";

async function assertMissing(filePath: string) {
  await assert.rejects(
    stat(filePath),
    (error: any) => error?.code === "ENOENT",
  );
}

test("createAgentHome places isolated homes under explicit dataRoot", async () => {
  const root = await tempRoot("cpb-agent-home-explicit-root");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");

  const env = await createAgentHome(cpbRoot, "codex", "job-1", {
    dataRoot,
    parentEnv: { HOME: path.join(root, "user-home") },
    isolateTemp: true,
  });

  assert.equal(env.HOME, path.join(dataRoot, "agent-homes", "codex", "job-1"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, ".config"));
  assert.equal(env.TMPDIR, path.join(env.HOME, ".tmp"));
  assert.equal(env.TMP, env.TMPDIR);
  assert.equal(env.TEMP, env.TMPDIR);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  if (process.platform === "darwin") {
    assert.match(String(env.PATH), /^\/Applications\/Xcode\.app\/Contents\/Developer\/usr\/bin(?::|$)|^\/Library\/Developer\/CommandLineTools\/usr\/bin(?::|$)/);
    if (existsSync("/opt/anaconda3/bin")) assert.match(String(env.PATH), /(?:^|:)\/opt\/anaconda3\/bin(?:[:]|$)/);
  }
  await stat(env.HOME);
  await stat(env.TMPDIR);
  await assertMissing(path.join(cpbRoot, "cpb-task", "agent-homes"));
});

test("createAgentHome snapshots Codex auth but excludes version-sensitive user config", async () => {
  const root = await tempRoot("cpb-agent-home-codex-snapshot");
  const userHome = path.join(root, "user-home");
  const sourceCodexHome = path.join(userHome, ".codex");
  const dataRoot = path.join(root, "project-runtime");
  await mkdir(sourceCodexHome, { recursive: true });
  await writeFile(path.join(sourceCodexHome, "auth.json"), "{\"token\":\"fixture\"}\n", "utf8");
  await writeFile(path.join(sourceCodexHome, "config.toml"), "model = \"fixture\"\n", "utf8");

  const env = await createAgentHome(path.join(root, "cpb"), "codex", "job-snapshot", {
    dataRoot,
    parentEnv: { HOME: userHome },
  });
  const authPath = path.join(env.CODEX_HOME!, "auth.json");
  const configPath = path.join(env.CODEX_HOME!, "config.toml");

  assert.equal((await lstat(authPath)).isSymbolicLink(), false);
  assert.equal(await readFile(authPath, "utf8"), "{\"token\":\"fixture\"}\n");
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  await assertMissing(configPath);
});

test("createAgentHome places isolated homes under CPB_PROJECT_RUNTIME_ROOT", async () => {
  const root = await tempRoot("cpb-agent-home-env-root");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");

  const env = await createAgentHome(cpbRoot, "claude", "job-2", {
    parentEnv: {
      HOME: path.join(root, "user-home"),
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
    },
  });

  assert.equal(env.HOME, path.join(dataRoot, "agent-homes", "claude", "job-2"));
  await stat(env.HOME);
  await assertMissing(path.join(cpbRoot, "cpb-task", "agent-homes"));
});

test("createAgentHome fails closed for project job context without runtime root", async () => {
  const root = await tempRoot("cpb-agent-home-missing-root");
  const cpbRoot = path.join(root, "cpb");

  await assert.rejects(
    createAgentHome(cpbRoot, "codex", "job-missing", {
      parentEnv: {
        CPB_ACP_PROJECT: "flow",
        CPB_ACP_JOB_ID: "job-missing",
      },
    }),
    /CPB_PROJECT_RUNTIME_ROOT is required/,
  );
  await assertMissing(path.join(cpbRoot, "cpb-task", "agent-homes"));
});

test("AcpClient.start fails closed for project job env without runtime root", async () => {
  const root = await tempRoot("cpb-acp-client-missing-root");
  const cpbRoot = path.join(root, "cpb");
  const client = new AcpClient({
    agent: "codex",
    cwd: root,
    prompt: "",
    outputSink: () => {},
    errorSink: () => {},
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_ACP_CPB_ROOT: cpbRoot,
      CPB_ACP_PROJECT: "flow",
      CPB_ACP_JOB_ID: "job-client-missing-root",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: JSON.stringify(["-e", "process.exit(0)"]),
    },
  });

  try {
    await assert.rejects(
      client.start(),
      /CPB_PROJECT_RUNTIME_ROOT is required/,
    );
    await assertMissing(path.join(cpbRoot, "cpb-task", "agent-homes"));
  } finally {
    await client.close();
  }
});

test("resolveAcpAuditFile uses project runtime root and skips legacy fallback", async () => {
  const root = await tempRoot("cpb-acp-audit-runtime-root");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");

  assert.equal(
    resolveAcpAuditFile({
      CPB_ROOT: cpbRoot,
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
      CPB_ACP_PROJECT: "flow",
      CPB_ACP_JOB_ID: "job-audit",
    }),
    path.join(dataRoot, "acp-audit", "flow", "job-audit.jsonl"),
  );
  assert.equal(
    resolveAcpAuditFile({
      CPB_ROOT: cpbRoot,
      CPB_ACP_PROJECT: "flow",
      CPB_ACP_JOB_ID: "job-audit",
    }),
    null,
  );
});
