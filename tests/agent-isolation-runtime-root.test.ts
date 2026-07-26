import assert from "node:assert/strict";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  __withAgentIsolationTestHooks,
  cleanupAgentHomes,
  createAgentHome,
  resolveAgentHomeRuntimeRoot,
} from "../core/agents/isolation.js";
import { AcpClient, resolveAcpAuditFile } from "../server/services/acp/acp-client.js";
import { AcpPool } from "../server/services/acp/acp-pool.js";
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

test("createAgentHome gives concurrent instances distinct homes beneath one job", async () => {
  const root = await tempRoot("cpb-agent-home-instance-scope");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");

  const executor = await createAgentHome(cpbRoot, "codex", "job-1", {
    dataRoot,
    parentEnv: { HOME: path.join(root, "user-home") },
    instanceId: "conversation-executor",
  });
  const verifier = await createAgentHome(cpbRoot, "codex", "job-1", {
    dataRoot,
    parentEnv: { HOME: path.join(root, "user-home") },
    instanceId: "../conversation/verifier",
  });
  const jobHome = path.join(dataRoot, "agent-homes", "codex", "job-1");

  assert.equal(executor.HOME, path.join(jobHome, "conversation-executor"));
  assert.equal(verifier.HOME, path.join(jobHome, "conversation-verifier"));
  assert.notEqual(executor.HOME, verifier.HOME);
});

test("createAgentHome rejects path traversal and alias segments", async () => {
  const root = await tempRoot("cpb-agent-home-segment-guard");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");

  await assert.rejects(
    createAgentHome(cpbRoot, "../codex", "job-1", { dataRoot }),
    { code: "CPB_AGENT_HOME_INVALID_SEGMENT" },
  );
  await assert.rejects(
    createAgentHome(cpbRoot, "codex", "../job-1", { dataRoot }),
    { code: "CPB_AGENT_HOME_INVALID_SEGMENT" },
  );
  await assert.rejects(
    createAgentHome(cpbRoot, "codex", "job-1", { dataRoot, instanceId: "../.." }),
    { code: "CPB_AGENT_HOME_INVALID_SEGMENT" },
  );
  await assertMissing(path.join(root, "codex"));
});

test("agent HOME roots reject serialized missing-value sentinels before writing", async () => {
  const root = await tempRoot("cpb-agent-home-invalid-root");
  const sentinelRoot = path.join(root, "undefined");

  for (const value of [undefined, "", "   ", "undefined", "null", sentinelRoot]) {
    assert.throws(
      () => resolveAgentHomeRuntimeRoot(value, "CPB_ROOT"),
      { code: "CPB_AGENT_HOME_INVALID_ROOT" },
    );
  }
  await assert.rejects(
    createAgentHome(sentinelRoot, "codex", "job-invalid-root", {
      parentEnv: { HOME: path.join(root, "user-home") },
    }),
    { code: "CPB_AGENT_HOME_INVALID_ROOT" },
  );
  assert.throws(
    () => new AcpPool({
      env: { CPB_ROOT: "undefined" },
      hubRoot: path.join(root, "hub"),
      runner: async () => "unused",
    }),
    { code: "CPB_AGENT_HOME_INVALID_ROOT" },
  );
  await assertMissing(sentinelRoot);
});

test("createAgentHome snapshots Codex auth but excludes version-sensitive user config", async () => {
  const root = await tempRoot("cpb-agent-home-codex-snapshot");
  const userHome = path.join(root, "user-home");
  const sourceCodexHome = path.join(userHome, ".codex");
  const dataRoot = path.join(root, "project-runtime");
  const targetCodexHome = path.join(dataRoot, "agent-homes", "codex", "job-snapshot", ".codex");
  await mkdir(sourceCodexHome, { recursive: true });
  await mkdir(targetCodexHome, { recursive: true });
  await writeFile(path.join(sourceCodexHome, "auth.json"), "{\"token\":\"fixture\"}\n", "utf8");
  await writeFile(path.join(sourceCodexHome, "config.toml"), "model = \"fixture\"\n", "utf8");
  await writeFile(path.join(targetCodexHome, "config.toml"), "model = \"legacy\"\n", "utf8");

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
  const quarantinedConfig = (await readdir(targetCodexHome))
    .find((entry) => entry.startsWith("config.toml.quarantine-"));
  assert.ok(quarantinedConfig);
  assert.equal(await readFile(path.join(targetCodexHome, quarantinedConfig), "utf8"), "model = \"legacy\"\n");
});

test("createAgentHome refuses symlinked Codex auth sources without deleting user auth", async () => {
  const root = await tempRoot("cpb-agent-home-codex-symlink-source");
  const userHome = path.join(root, "user-home");
  const sourceCodexHome = path.join(userHome, ".codex");
  const outside = path.join(root, "outside-auth.json");
  const dataRoot = path.join(root, "project-runtime");
  await mkdir(sourceCodexHome, { recursive: true });
  await writeFile(outside, "{\"token\":\"outside\"}\n", "utf8");
  await symlink(outside, path.join(sourceCodexHome, "auth.json"));

  await assert.rejects(
    createAgentHome(path.join(root, "cpb"), "codex", "job-symlink-source", {
      dataRoot,
      parentEnv: { HOME: userHome },
    }),
    { code: "CPB_AGENT_HOME_UNSAFE_AUTH_SOURCE" },
  );

  assert.equal(await readFile(outside, "utf8"), "{\"token\":\"outside\"}\n");
  assert.equal((await lstat(path.join(sourceCodexHome, "auth.json"))).isSymbolicLink(), true);
});

test("createAgentHome refuses oversized auth sources before copying", async () => {
  const root = await tempRoot("cpb-agent-home-codex-oversized-source");
  const userHome = path.join(root, "user-home");
  const sourceCodexHome = path.join(userHome, ".codex");
  const dataRoot = path.join(root, "project-runtime");
  await mkdir(sourceCodexHome, { recursive: true });
  await writeFile(path.join(sourceCodexHome, "auth.json"), "x".repeat(1024 * 1024 + 1), "utf8");

  await assert.rejects(
    createAgentHome(path.join(root, "cpb"), "codex", "job-oversized-source", {
      dataRoot,
      parentEnv: { HOME: userHome },
    }),
    { code: "CPB_AGENT_HOME_AUTH_TOO_LARGE" },
  );

  await assertMissing(path.join(dataRoot, "agent-homes", "codex", "job-oversized-source", ".codex", "auth.json"));
});

test("createAgentHome refuses symlinked isolated auth/config targets without deleting successors", async () => {
  const root = await tempRoot("cpb-agent-home-codex-symlink-target");
  const userHome = path.join(root, "user-home");
  const sourceCodexHome = path.join(userHome, ".codex");
  const dataRoot = path.join(root, "project-runtime");
  const targetHome = path.join(dataRoot, "agent-homes", "codex", "job-symlink-target", ".codex");
  const successorAuth = path.join(root, "successor-auth.json");
  await mkdir(sourceCodexHome, { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(path.join(sourceCodexHome, "auth.json"), "{\"token\":\"source\"}\n", "utf8");
  await writeFile(successorAuth, "{\"token\":\"successor\"}\n", "utf8");
  await symlink(successorAuth, path.join(targetHome, "auth.json"));

  await assert.rejects(
    createAgentHome(path.join(root, "cpb"), "codex", "job-symlink-target", {
      dataRoot,
      parentEnv: { HOME: userHome },
    }),
    { code: "CPB_AGENT_HOME_UNSAFE_AUTH_TARGET" },
  );

  assert.equal(await readFile(successorAuth, "utf8"), "{\"token\":\"successor\"}\n");
  assert.equal((await lstat(path.join(targetHome, "auth.json"))).isSymbolicLink(), true);
});

test("createAgentHome refuses stale config symlink cleanup without deleting its target", async () => {
  const root = await tempRoot("cpb-agent-home-config-symlink-target");
  const userHome = path.join(root, "user-home");
  const sourceCodexHome = path.join(userHome, ".codex");
  const dataRoot = path.join(root, "project-runtime");
  const targetHome = path.join(dataRoot, "agent-homes", "codex", "job-config-symlink", ".codex");
  const successorConfig = path.join(root, "successor-config.toml");
  await mkdir(sourceCodexHome, { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(path.join(sourceCodexHome, "auth.json"), "{\"token\":\"source\"}\n", "utf8");
  await writeFile(successorConfig, "model = \"successor\"\n", "utf8");
  await symlink(successorConfig, path.join(targetHome, "config.toml"));

  await assert.rejects(
    createAgentHome(path.join(root, "cpb"), "codex", "job-config-symlink", {
      dataRoot,
      parentEnv: { HOME: userHome },
    }),
    { code: "CPB_AGENT_HOME_UNSAFE_AUTH_TARGET" },
  );

  assert.equal(await readFile(successorConfig, "utf8"), "model = \"successor\"\n");
  assert.equal((await lstat(path.join(targetHome, "config.toml"))).isSymbolicLink(), true);
});

test("createAgentHome preserves a racing config successor after quarantine", async () => {
  const root = await tempRoot("cpb-agent-home-config-successor-race");
  const userHome = path.join(root, "user-home");
  const dataRoot = path.join(root, "project-runtime");
  const targetHome = path.join(dataRoot, "agent-homes", "codex", "job-config-race", ".codex");
  const configPath = path.join(targetHome, "config.toml");
  await mkdir(path.join(userHome, ".codex"), { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(configPath, "model = \"predecessor\"\n", "utf8");

  let quarantinePath = "";
  await __withAgentIsolationTestHooks(
    {
      afterAuthTargetIsolation: async ({ target, quarantine }) => {
        if (target !== configPath) return;
        quarantinePath = quarantine;
        await writeFile(target, "model = \"successor\"\n", "utf8");
      },
    },
    () => assert.rejects(
      createAgentHome(path.join(root, "cpb"), "codex", "job-config-race", {
        dataRoot,
        parentEnv: { HOME: userHome },
      }),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string;
          quarantinePreserved?: boolean;
          recoveryPaths?: { target?: string; quarantine?: string };
          successorPreserved?: boolean;
        };
        assert.equal(actual.code, "CPB_AGENT_HOME_AUTH_SUCCESSOR_PRESERVED");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, quarantinePath);
        assert.equal(actual.quarantinePreserved, true);
        assert.deepEqual(actual.recoveryPaths, { target: configPath, quarantine: quarantinePath });
        assert.equal(actual.successorPreserved, true);
        return true;
      },
    ),
  );

  assert.equal(await readFile(configPath, "utf8"), "model = \"successor\"\n");
  assert.equal(await readFile(quarantinePath, "utf8"), "model = \"predecessor\"\n");
});

test("createAgentHome rejects same-inode config metadata changes before quarantine", async () => {
  const root = await tempRoot("cpb-agent-home-config-generation-race");
  const userHome = path.join(root, "user-home");
  const dataRoot = path.join(root, "project-runtime");
  const targetHome = path.join(dataRoot, "agent-homes", "codex", "job-config-generation", ".codex");
  const configPath = path.join(targetHome, "config.toml");
  await mkdir(path.join(userHome, ".codex"), { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(configPath, "model = \"stable\"\n", "utf8");
  await utimes(configPath, new Date(1_000), new Date(1_000));

  let originalInode: bigint | number | null = null;
  await __withAgentIsolationTestHooks(
    {
      beforeAuthTargetIsolation: async ({ target }) => {
        if (target !== configPath) return;
        originalInode = (await lstat(target)).ino;
        await utimes(target, new Date(2_000), new Date(2_000));
        assert.equal((await lstat(target)).ino, originalInode);
      },
    },
    () => assert.rejects(
      createAgentHome(path.join(root, "cpb"), "codex", "job-config-generation", {
        dataRoot,
        parentEnv: { HOME: userHome },
      }),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string | null;
          recoveryPaths?: { target?: string; quarantine?: string };
          successorPreserved?: boolean;
        };
        assert.equal(actual.code, "CPB_AGENT_HOME_AUTHORITY_CHANGED");
        assert.equal(actual.committed, false);
        assert.equal(actual.committedPath, null);
        assert.equal(actual.recoveryPaths?.target, configPath);
        assert.match(String(actual.recoveryPaths?.quarantine), /config\.toml\.quarantine-/);
        assert.equal(actual.successorPreserved, true);
        return true;
      },
    ),
  );

  assert.equal((await lstat(configPath)).ino, originalInode);
  assert.equal(await readFile(configPath, "utf8"), "model = \"stable\"\n");
  assert.deepEqual(
    (await readdir(targetHome)).filter((entry) => entry.startsWith("config.toml.quarantine-")),
    [],
  );
});

test("createAgentHome uses strict directory flags and preserves committed auth cleanup evidence", async () => {
  const root = await tempRoot("cpb-agent-home-config-strict-directory");
  const userHome = path.join(root, "user-home");
  const dataRoot = path.join(root, "project-runtime");
  const targetHome = path.join(dataRoot, "agent-homes", "codex", "job-config-strict", ".codex");
  const configPath = path.join(targetHome, "config.toml");
  await mkdir(path.join(userHome, ".codex"), { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(configPath, "model = \"legacy\"\n", "utf8");

  let observedFlags = 0;
  let quarantinePath = "";
  await __withAgentIsolationTestHooks(
    {
      afterAuthTargetIsolation: ({ quarantine }) => {
        quarantinePath = quarantine;
      },
      openDirectory: async (directory, flags) => {
        observedFlags = flags;
        throw Object.assign(new Error(`hostile directory substitution: ${directory}`), { code: "ELOOP" });
      },
    },
    () => assert.rejects(
      createAgentHome(path.join(root, "cpb"), "codex", "job-config-strict", {
        dataRoot,
        parentEnv: { HOME: userHome },
      }),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string;
          quarantinePreserved?: boolean;
          recoveryPaths?: { target?: string; quarantine?: string };
          successorPreserved?: boolean;
        };
        assert.equal(actual.code, "CPB_AGENT_HOME_AUTH_CLEANUP_COMMITTED_AMBIGUOUS");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, quarantinePath);
        assert.equal(actual.quarantinePreserved, true);
        assert.deepEqual(actual.recoveryPaths, { target: configPath, quarantine: quarantinePath });
        assert.equal(actual.successorPreserved, false);
        return true;
      },
    ),
  );

  assert.notEqual(observedFlags & constants.O_NOFOLLOW, 0);
  assert.notEqual(observedFlags & constants.O_DIRECTORY, 0);
  await assertMissing(configPath);
  assert.equal(await readFile(quarantinePath, "utf8"), "model = \"legacy\"\n");
});

test("agent isolation hostile hooks stay scoped across concurrent home creation", async () => {
  const root = await tempRoot("cpb-agent-home-hook-scope");
  const userHome = path.join(root, "user-home");
  const dataRoot = path.join(root, "project-runtime");
  const firstConfig = path.join(dataRoot, "agent-homes", "codex", "job-hook-a", ".codex", "config.toml");
  const secondConfig = path.join(dataRoot, "agent-homes", "codex", "job-hook-b", ".codex", "config.toml");
  await mkdir(path.join(userHome, ".codex"), { recursive: true });
  await mkdir(path.dirname(firstConfig), { recursive: true });
  await mkdir(path.dirname(secondConfig), { recursive: true });
  await writeFile(firstConfig, "model = \"first\"\n", "utf8");
  await writeFile(secondConfig, "model = \"second\"\n", "utf8");

  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
  const firstRun = __withAgentIsolationTestHooks(
    {
      beforeAuthTargetIsolation: async ({ target }) => {
        if (target !== firstConfig) return;
        markFirstEntered();
        await firstGate;
        throw new Error("hostile first-scope pause");
      },
    },
    () => createAgentHome(path.join(root, "cpb"), "codex", "job-hook-a", {
      dataRoot,
      parentEnv: { HOME: userHome },
    }),
  );

  await firstEntered;
  await __withAgentIsolationTestHooks(
    {},
    () => createAgentHome(path.join(root, "cpb"), "codex", "job-hook-b", {
      dataRoot,
      parentEnv: { HOME: userHome },
    }),
  );
  releaseFirst();
  await assert.rejects(firstRun, { code: "CPB_AGENT_HOME_AUTHORITY_CHANGED" });

  assert.equal(await readFile(firstConfig, "utf8"), "model = \"first\"\n");
  await assertMissing(secondConfig);
  assert.equal(
    (await readdir(path.dirname(secondConfig))).filter((entry) => entry.startsWith("config.toml.quarantine-")).length,
    1,
  );
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

test("cleanupAgentHomes quarantines stale homes and preserves recovery evidence", async () => {
  const root = await tempRoot("cpb-agent-home-cleanup-quarantine");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");
  const staleHome = path.join(dataRoot, "agent-homes", "codex", "job-old");
  await mkdir(staleHome, { recursive: true });
  await writeFile(path.join(staleHome, "sentinel.txt"), "preserve\n", "utf8");
  const old = new Date(0);
  await utimes(staleHome, old, old);

  const cleaned = await cleanupAgentHomes(cpbRoot, {
    dataRoot,
    now: Date.now(),
    maxAgeMs: 1,
  });

  assert.equal(cleaned, 1);
  await assertMissing(staleHome);
  const siblings = await readdir(path.dirname(staleHome));
  const quarantine = siblings.find((name) => name.startsWith("job-old.quarantine-"));
  assert.ok(quarantine);
  const quarantinePath = path.join(path.dirname(staleHome), quarantine);
  assert.equal(await readFile(path.join(quarantinePath, "sentinel.txt"), "utf8"), "preserve\n");

  const cleanedAgain = await cleanupAgentHomes(cpbRoot, {
    dataRoot,
    now: Date.now(),
    maxAgeMs: 1,
  });
  assert.equal(cleanedAgain, 0);
  assert.equal(await readFile(path.join(quarantinePath, "sentinel.txt"), "utf8"), "preserve\n");
  assert.deepEqual(
    (await readdir(path.dirname(staleHome))).filter((name) => name.startsWith("job-old.quarantine-")),
    [quarantine],
  );
});

test("cleanupAgentHomes rejects same-inode metadata changes before quarantine", async () => {
  const root = await tempRoot("cpb-agent-home-cleanup-generation-race");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");
  const staleHome = path.join(dataRoot, "agent-homes", "codex", "job-generation-race");
  await mkdir(staleHome, { recursive: true });
  await writeFile(path.join(staleHome, "sentinel.txt"), "predecessor\n", "utf8");
  await utimes(staleHome, new Date(1_000), new Date(1_000));

  let originalInode: bigint | number | null = null;
  await __withAgentIsolationTestHooks(
    {
      beforeAgentHomeIsolation: async ({ home }) => {
        if (home !== staleHome) return;
        originalInode = (await lstat(home)).ino;
        await utimes(home, new Date(2_000), new Date(2_000));
        assert.equal((await lstat(home)).ino, originalInode);
      },
    },
    () => assert.rejects(
      cleanupAgentHomes(cpbRoot, {
        dataRoot,
        now: Date.now(),
        maxAgeMs: 1,
      }),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string | null;
          recoveryPaths?: { home?: string; quarantine?: string };
          successorPreserved?: boolean;
        };
        assert.equal(actual.code, "CPB_AGENT_HOME_AUTHORITY_CHANGED");
        assert.equal(actual.committed, false);
        assert.equal(actual.committedPath, null);
        assert.equal(actual.recoveryPaths?.home, staleHome);
        assert.match(String(actual.recoveryPaths?.quarantine), /job-generation-race\.quarantine-/);
        assert.equal(actual.successorPreserved, true);
        return true;
      },
    ),
  );

  assert.equal((await lstat(staleHome)).ino, originalInode);
  assert.equal(await readFile(path.join(staleHome, "sentinel.txt"), "utf8"), "predecessor\n");
  assert.deepEqual(
    (await readdir(path.dirname(staleHome))).filter((entry) => entry.startsWith("job-generation-race.quarantine-")),
    [],
  );
});

test("cleanupAgentHomes preserves a canonical successor after quarantine", async () => {
  const root = await tempRoot("cpb-agent-home-cleanup-successor-race");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");
  const staleHome = path.join(dataRoot, "agent-homes", "codex", "job-successor-race");
  await mkdir(staleHome, { recursive: true });
  await writeFile(path.join(staleHome, "sentinel.txt"), "predecessor\n", "utf8");
  await utimes(staleHome, new Date(1_000), new Date(1_000));

  let quarantinePath = "";
  await __withAgentIsolationTestHooks(
    {
      afterAgentHomeIsolation: async ({ home, quarantine }) => {
        if (home !== staleHome) return;
        quarantinePath = quarantine;
        await mkdir(home, { recursive: false });
        await writeFile(path.join(home, "sentinel.txt"), "successor\n", "utf8");
      },
    },
    () => assert.rejects(
      cleanupAgentHomes(cpbRoot, {
        dataRoot,
        now: Date.now(),
        maxAgeMs: 1,
      }),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string;
          quarantinePreserved?: boolean;
          recoveryPaths?: { home?: string; quarantine?: string };
          successorPreserved?: boolean;
        };
        assert.equal(actual.code, "CPB_AGENT_HOME_SUCCESSOR_PRESERVED");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, quarantinePath);
        assert.equal(actual.quarantinePreserved, true);
        assert.deepEqual(actual.recoveryPaths, { home: staleHome, quarantine: quarantinePath });
        assert.equal(actual.successorPreserved, true);
        return true;
      },
    ),
  );

  assert.equal(await readFile(path.join(staleHome, "sentinel.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(quarantinePath, "sentinel.txt"), "utf8"), "predecessor\n");
});

test("cleanupAgentHomes refuses symlink job homes without deleting targets", async () => {
  const root = await tempRoot("cpb-agent-home-cleanup-symlink");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");
  const agentDir = path.join(dataRoot, "agent-homes", "codex");
  const external = path.join(root, "external-home");
  await mkdir(agentDir, { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "sentinel.txt"), "external\n", "utf8");
  await symlink(external, path.join(agentDir, "job-link"), "dir");

  await assert.rejects(
    cleanupAgentHomes(cpbRoot, {
      dataRoot,
      now: Date.now(),
      maxAgeMs: 1,
    }),
    { code: "CPB_AGENT_HOME_UNSAFE_PATH" },
  );

  assert.equal(await readFile(path.join(external, "sentinel.txt"), "utf8"), "external\n");
  assert.equal((await lstat(path.join(agentDir, "job-link"))).isSymbolicLink(), true);
});

test("cleanupAgentHomes honors active leases before quarantine", async () => {
  const root = await tempRoot("cpb-agent-home-cleanup-active-lease");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "project-runtime");
  const activeHome = path.join(dataRoot, "agent-homes", "codex", "job-active");
  await mkdir(activeHome, { recursive: true });
  await writeFile(path.join(activeHome, "sentinel.txt"), "active\n", "utf8");
  const old = new Date(0);
  await utimes(activeHome, old, old);

  const cleaned = await cleanupAgentHomes(cpbRoot, {
    dataRoot,
    now: Date.now(),
    maxAgeMs: 1,
    isLeaseActive: async (jobId) => jobId === "job-active",
  });

  assert.equal(cleaned, 0);
  assert.equal(await readFile(path.join(activeHome, "sentinel.txt"), "utf8"), "active\n");
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

test("AcpClient startup failures retain a bounded redacted stderr tail", async () => {
  const root = await tempRoot("cpb-acp-client-startup-stderr");
  const client = new AcpClient({
    agent: "codex",
    cwd: root,
    prompt: "",
    outputSink: () => {},
    errorSink: () => {},
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_AGENT_SANDBOX: "off",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: JSON.stringify([
        "-e",
        "process.stderr.write('sandbox bootstrap denied token=supersecret123'); process.exit(23)",
      ]),
    },
  });

  try {
    await assert.rejects(
      client.start(),
      (error: any) => {
        assert.match(error.message, /code=23/);
        assert.match(error.message, /sandbox bootstrap denied/);
        assert.match(error.message, /token=\[REDACTED\]/);
        assert.doesNotMatch(error.message, /supersecret123/);
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("AcpClient retains an exact canonical child identity when HOME isolation is disabled", async () => {
  const root = await tempRoot("cpb-acp-client-exact-identity");
  const client = new AcpClient({
    agent: "codex",
    cwd: root,
    prompt: "",
    outputSink: () => {},
    errorSink: () => {},
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_AGENT_SANDBOX: "off",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: JSON.stringify([
        "-e",
        "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n')})",
      ]),
    },
  });

  try {
    await client.start();
    assert.ok(client.childIdentity);
    assert.equal(client.childIdentity.birthIdPrecision, "exact");
    assert.equal(client.childIdentity.incarnation, `${client.childIdentity.pid}:${client.childIdentity.birthId}`);
  } finally {
    await client.close();
  }
});

test("AcpClient attributes concurrent fast startup exits consistently without EPIPE or identity masking", async () => {
  const root = await tempRoot("cpb-acp-client-concurrent-startup-stderr");
  const clients = Array.from({ length: 4 }, (_, index) => new AcpClient({
    agent: "codex",
    cwd: root,
    prompt: "",
    outputSink: () => {},
    errorSink: () => {},
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_AGENT_SANDBOX: "off",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: JSON.stringify([
        "-e",
        `process.stderr.write('concurrent startup denied ${index} token=concurrentsecret${index}'); process.exit(${31 + index})`,
      ]),
    },
  }));

  try {
    const failures = await Promise.all(clients.map(async (client) => {
      try {
        await client.start();
        assert.fail("fast failing ACP client unexpectedly initialized");
      } catch (error) {
        return error as Error & { code?: string; exitCode?: number };
      }
    }));
    for (const [index, failure] of failures.entries()) {
      assert.equal(failure.code, "ACP_AGENT_STARTUP_FAILED");
      assert.equal(failure.exitCode, 31 + index);
      assert.match(failure.message, new RegExp(`code=${31 + index}`));
      assert.match(failure.message, new RegExp(`concurrent startup denied ${index}`));
      assert.match(failure.message, /token=\[REDACTED\]/);
      assert.doesNotMatch(failure.message, new RegExp(`concurrentsecret${index}`));
      assert.doesNotMatch(failure.message, /EPIPE|exact canonical identity/);
      assert.ok(failure.message.length <= 1500);
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
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
