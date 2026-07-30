import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentHome, inheritFilesIntoHome } from "../core/agents/isolation.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { getDescriptor, isBuiltinDescriptor, loadRegistry } from "../core/agents/registry.js";

const clean = (dir) => rm(dir, { recursive: true, force: true });

// B2b: the generic descriptor-driven inheritFiles path is reached
// unconditionally. Load once for the file so codex/claude descriptors — and
// their inheritFiles/quarantineFiles — are visible to createAgentHome.
await loadRegistry("");

test("createAgentHome builds 0o700 HOME under dataRoot with git-neutral env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const env = await createAgentHome(dir, "codex", "job-1", { dataRoot });
    assert.ok(env.HOME.startsWith(path.join(dataRoot, "agent-homes", "codex", "job-1")));
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(typeof env.PATH, "string");
    const st = await stat(env.HOME);
    assert.equal(st.mode & 0o777, 0o700);
    for (const sub of [".config", ".local/share", ".cache", ".tmp"]) {
      await stat(path.join(env.HOME, sub)); // 存在即通过
    }
  } finally { await clean(dir); }
});

test("safeSegment rejects path-traversing agentName", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    await assert.rejects(
      () => createAgentHome(dir, "../evil", "job-1", { dataRoot }),
      (err: unknown) => (err as { code?: string }).code === "CPB_AGENT_HOME_INVALID_SEGMENT",
    );
  } finally { await clean(dir); }
});

test("codex (no CODEX_HOME): copies auth.json from $HOME/.codex", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const fakeHome = path.join(dir, "userhome");
    await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
    await writeFile(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
    const env = await createAgentHome(dir, "codex", "job-2", { dataRoot, parentEnv: { HOME: fakeHome } });
    const copied = await readFile(path.join(env.HOME, ".codex", "auth.json"), "utf8");
    assert.equal(copied, '{"token":"x"}');
  } finally { await clean(dir); }
});

test("codex: stale config.toml in target home is quarantined on re-run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const fakeHome = path.join(dir, "userhome");
    await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
    await writeFile(path.join(fakeHome, ".codex", "auth.json"), "{}");
    const env1 = await createAgentHome(dir, "codex", "job-3", { dataRoot, parentEnv: { HOME: fakeHome } });
    // 模拟旧 CPB run 留下的 config.toml
    await writeFile(path.join(env1.HOME, ".codex", "config.toml"), 'model = "old"');
    // 同一 home 再跑一次 → descriptor quarantineFiles 应把它 quarantine
    await createAgentHome(dir, "codex", "job-3", { dataRoot, parentEnv: { HOME: fakeHome } });
    const entries = await readdir(path.join(env1.HOME, ".codex"));
    assert.ok(entries.some((e) => e.startsWith("config.toml.quarantine-")), entries.join(","));
  } finally { await clean(dir); }
});

test("parentEnv.CODEX_HOME set → inheritFiles resolves $CODEX_HOME to custom root [B2b new behavior]", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const customCodexHome = path.join(dir, "custom-codex");
    const parentHome = path.join(dir, "userhome");
    await mkdir(customCodexHome, { recursive: true });
    await mkdir(parentHome, { recursive: true });
    await writeFile(path.join(customCodexHome, "auth.json"), '{"token":"y"}');
    const env = await createAgentHome(dir, "codex", "job-4", {
      dataRoot,
      parentEnv: { HOME: parentHome, CODEX_HOME: customCodexHome },
    });
    // B2b: descriptor-driven inheritFiles resolves `from: "$CODEX_HOME/auth.json"`
    // against parentEnv.CODEX_HOME, so auth IS now inherited from the custom
    // root (replaces the legacy skip-on-CODEX_HOME gating that left the isolated
    // codex without auth). The §6.2 env-awareness fix.
    const copied = await readFile(path.join(env.HOME, ".codex", "auth.json"), "utf8");
    assert.equal(copied, '{"token":"y"}');
    const childEnv = buildChildEnv(
      { HOME: parentHome, CODEX_HOME: customCodexHome },
      env,
      { agent: "codex" },
    );
    assert.equal(childEnv.CODEX_HOME, path.join(env.HOME, ".codex"));
  } finally { await clean(dir); }
});

test("user descriptor overriding a builtin name is not treated as builtin-trusted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const configDir = path.join(dir, "config");
    const restoreDir = path.join(dir, "restore");
    const parentHome = path.join(dir, "parent");
    await mkdir(configDir, { recursive: true });
    await mkdir(parentHome, { recursive: true });
    await mkdir(path.join(parentHome, ".codex"), { recursive: true });
    await writeFile(path.join(parentHome, ".codex", "auth.json"), "user-auth");
    await writeFile(
      path.join(configDir, "codex.json"),
      `${JSON.stringify({
        name: "codex",
        command: "user-codex",
        envPrefix: "CPB_ACP_USER_CODEX",
        inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/copied.json" }],
        quarantineFiles: [],
      })}\n`,
    );
    await loadRegistry(configDir);
    assert.equal(isBuiltinDescriptor("codex"), false);
    assert.equal(getDescriptor("codex")?.command, "user-codex");

    const env = await createAgentHome(dir, "codex", "user-override", {
      dataRoot: path.join(dir, "runtime"),
      parentEnv: { HOME: parentHome },
    });
    assert.equal(await readFile(path.join(env.HOME, "copied.json"), "utf8"), "user-auth");

    await mkdir(restoreDir, { recursive: true });
    await loadRegistry(restoreDir);
  } finally {
    await clean(dir);
  }
});

test("unsafe user inheritFiles are rejected while the builtin descriptor remains active", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const configDir = path.join(dir, "config");
    const restoreDir = path.join(dir, "restore");
    const outside = path.join(dir, "outside");
    await mkdir(configDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(
      path.join(configDir, "codex.json"),
      `${JSON.stringify({
        name: "codex",
        command: "unsafe-user-codex",
        inheritFiles: [{ from: `${outside}/auth.json`, to: "$HOME/leak.json" }],
        quarantineFiles: [],
      })}\n`,
    );
    await loadRegistry(configDir);
    assert.equal(isBuiltinDescriptor("codex"), true);
    assert.notEqual(getDescriptor("codex")?.command, "unsafe-user-codex");
    await mkdir(restoreDir, { recursive: true });
    await loadRegistry(restoreDir);
  } finally {
    await clean(dir);
  }
});

// --- B2b Step 1: generic descriptor-driven inheritFilesIntoHome ---

test("generic inheritFilesIntoHome copies files per descriptor (codex-shaped, trusted)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const targetHome = path.join(dir, "target");
    await mkdir(targetHome, { recursive: true });
    await mkdir(path.join(parentHome, ".codex"), { recursive: true });
    await writeFile(path.join(parentHome, ".codex", "auth.json"), '{"token":"generic"}');
    await inheritFilesIntoHome(
      targetHome,
      { HOME: parentHome },
      {
        inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/.codex/auth.json" }],
        quarantineFiles: [],
      },
      { trusted: true },
    );
    const copied = await readFile(path.join(targetHome, ".codex", "auth.json"), "utf8");
    assert.equal(copied, '{"token":"generic"}');
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome is env-aware: $CODEX_HOME resolves to parentEnv.CODEX_HOME", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const customCodex = path.join(dir, "custom-codex");
    const targetHome = path.join(dir, "target");
    await mkdir(targetHome, { recursive: true });
    await mkdir(customCodex, { recursive: true });
    await mkdir(parentHome, { recursive: true });
    await writeFile(path.join(customCodex, "auth.json"), '{"token":"from-custom-codex-home"}');
    await inheritFilesIntoHome(
      targetHome,
      { HOME: parentHome, CODEX_HOME: customCodex },
      { inheritFiles: [{ from: "$CODEX_HOME/auth.json", to: "$HOME/.codex/auth.json" }] },
      { trusted: true },
    );
    const copied = await readFile(path.join(targetHome, ".codex", "auth.json"), "utf8");
    assert.equal(copied, '{"token":"from-custom-codex-home"}');
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome quarantines declared files (config.toml) before inheriting", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const targetHome = path.join(dir, "target");
    await mkdir(path.join(targetHome, ".codex"), { recursive: true });
    await writeFile(path.join(targetHome, ".codex", "config.toml"), 'model = "stale"');
    await inheritFilesIntoHome(
      targetHome,
      {},
      { inheritFiles: [], quarantineFiles: ["$HOME/.codex/config.toml"] },
      { trusted: true },
    );
    const entries = await readdir(path.join(targetHome, ".codex"));
    assert.ok(entries.some((e) => e.startsWith("config.toml.quarantine-")), entries.join(","));
    assert.ok(!entries.includes("config.toml"));
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome fail-closed: untrusted descriptor with non-credential basename rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const targetHome = path.join(dir, "target");
    await mkdir(targetHome, { recursive: true });
    await mkdir(parentHome, { recursive: true });
    await writeFile(path.join(parentHome, "evil.txt"), "leak");
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/evil.txt", to: "$HOME/evil.txt" }] },
        { trusted: false },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_UNTRUSTED_INHERIT_FILE",
    );
    await assert.rejects(() => readFile(path.join(targetHome, "evil.txt")));
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome fail-closed: untrusted from outside trusted env root rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const outside = path.join(dir, "outside");
    const targetHome = path.join(dir, "target");
    await mkdir(outside, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await mkdir(parentHome, { recursive: true });
    await writeFile(path.join(outside, "auth.json"), '{"token":"leaked"}');
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: `${outside}/auth.json`, to: "$HOME/auth.json" }] },
        { trusted: false },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_UNTRUSTED_INHERIT_SOURCE",
    );
    await assert.rejects(() => readFile(path.join(targetHome, "auth.json")));
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome fail-closed: 'to' escaping $HOME rejected even when trusted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const targetHome = path.join(dir, "target");
    await mkdir(parentHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await mkdir(path.join(parentHome, ".codex"), { recursive: true });
    await writeFile(path.join(parentHome, ".codex", "auth.json"), '{"token":"x"}');
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "/etc/cpb-leak/auth.json" }] },
        { trusted: true },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_PATH_ESCAPE",
    );
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/../../cpb-leak" }] },
        { trusted: true },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_PATH_ESCAPE",
    );
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome respects per-file maxBytes tighter than the global cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const targetHome = path.join(dir, "target");
    await mkdir(targetHome, { recursive: true });
    await mkdir(path.join(parentHome, ".codex"), { recursive: true });
    await writeFile(path.join(parentHome, ".codex", "auth.json"), "x".repeat(100));
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/.codex/auth.json", maxBytes: 10 }] },
        { trusted: true },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_AUTH_TOO_LARGE",
    );
    await assert.rejects(() => readFile(path.join(targetHome, ".codex", "auth.json")));
  } finally { await clean(dir); }
});

test("inheritFilesIntoHome refuses symlink from-source (trusted and untrusted)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const targetHome = path.join(dir, "target");
    const outside = path.join(dir, "outside-auth.json");
    await mkdir(targetHome, { recursive: true });
    await mkdir(path.join(parentHome, ".codex"), { recursive: true });
    await writeFile(outside, '{"token":"outside"}');
    await symlink(outside, path.join(parentHome, ".codex", "auth.json"));
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/.codex/auth.json" }] },
        { trusted: true },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_UNSAFE_AUTH_SOURCE",
    );
  } finally { await clean(dir); }
});

test("untrusted inheritFiles rejects an intermediate source symlink escape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const parentHome = path.join(dir, "parent");
    const targetHome = path.join(dir, "target");
    const outside = path.join(dir, "outside");
    await mkdir(parentHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "auth.json"), "outside-chain");
    await symlink(outside, path.join(parentHome, ".config"));
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.config/auth.json", to: "$HOME/copied.json" }] },
        { trusted: false },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_UNTRUSTED_INHERIT_SOURCE",
    );
    await assert.rejects(() => readFile(path.join(targetHome, "copied.json")));

    const targetOutside = path.join(dir, "outside-target");
    await mkdir(targetOutside, { recursive: true });
    await mkdir(path.join(parentHome, ".codex"), { recursive: true });
    await writeFile(path.join(parentHome, ".codex", "auth.json"), "inside-source");
    await symlink(targetOutside, path.join(targetHome, ".config"));
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/.config/copied.json" }] },
        { trusted: true },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_PATH_ESCAPE",
    );
    await assert.rejects(() => readFile(path.join(targetOutside, "copied.json")));

    const danglingTarget = path.join(targetHome, ".dangling");
    await symlink(path.join(dir, "missing-target"), danglingTarget);
    await assert.rejects(
      () => inheritFilesIntoHome(
        targetHome,
        { HOME: parentHome },
        { inheritFiles: [{ from: "$HOME/.codex/auth.json", to: "$HOME/.dangling/copied.json" }] },
        { trusted: true },
      ),
      (err: any) => err.code === "CPB_AGENT_HOME_PATH_ESCAPE",
    );
  } finally { await clean(dir); }
});
